/**
 * Smoke test del Simulador de Competencias (Modo Dios).
 *
 * Prueba el flujo completo vía HTTP:
 *   1. Login como superadmin
 *   2. POST /api/ajustes/descubrir-competencias  → encola job
 *   3. Polling GET /api/jobs/:id               → espera done
 *   4. GET /api/competencias                   → lista resultado
 *   5. POST /api/ajustes/simular-competencia   → nuevo JWT
 *   6. Verifica payload del nuevo JWT
 *
 * Uso:
 *   node scripts/smoke-test-simulador.js [competenciaCodigo]
 *
 *   Si se pasa un código (ej. 240202501), usa ese en el paso 5.
 *   Si no, usa la primera competencia de la lista descubierta.
 *
 * Requiere: servidor corriendo en localhost:3000 + ZAJUNA_USER/ZAJUNA_PASS en .env
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const BASE      = "http://localhost:3000";
const EMAIL     = "ddiddimmo@gmail.com";
const PASSWORD  = process.env.ZAJUNA_PASS || process.env.SUPERADMIN_PASS || "";
const COMP_ARG  = process.argv[2] || null;

let passed = 0;
let failed = 0;

function ok(label, detail = "")  { passed++; console.log(`  ✅ ${label}${detail ? "  →  " + detail : ""}`); }
function fail(label, detail = "") { failed++; console.log(`  ❌ ${label}${detail ? "  →  " + detail : ""}`); }
function section(title)           { console.log(`\n── ${title} ${"─".repeat(Math.max(0, 52 - title.length))}`); }

async function api(path, opts = {}, jwt = null) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...opts });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { return null; }
}

async function pollJob(jobId, jwt, maxSecs = 30) {
  const deadline = Date.now() + maxSecs * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 1500));
    const { body } = await api(`/api/jobs/${jobId}`, {}, jwt);
    process.stdout.write(`\r    progreso: ${body.progreso ?? "?"}%   `);
    if (body.status === "done")   { console.log(); return { ok: true,  resultado: body.resultado }; }
    if (body.status === "failed") { console.log(); return { ok: false, error: body.errorMsg }; }
  }
  console.log();
  return { ok: false, error: `Timeout (${maxSecs}s)` };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════");
  console.log("  SMOKE TEST — Simulador de Competencias (Modo Dios)");
  console.log("═══════════════════════════════════════════════════════════");

  // ── 1. Login ──────────────────────────────────────────────────────────────
  section("1. Login como superadmin");
  if (!PASSWORD) {
    fail("ZAJUNA_PASS no definido en .env — no se puede hacer login");
    console.log("\n  Tip: agrega ZAJUNA_PASS=<tu-contraseña> al .env");
    process.exit(1);
  }

  const { status: loginStatus, body: loginBody } = await api("/api/auth/login", {
    method: "POST",
    body:   JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });

  if (loginStatus !== 200 || !loginBody.token) {
    fail("Login", `HTTP ${loginStatus} — ${JSON.stringify(loginBody)}`);
    process.exit(1);
  }
  const jwt = loginBody.token;
  ok("Login", `email=${loginBody.user?.email}`);

  const payload1 = decodeJwt(jwt);
  if (payload1?.email === EMAIL) ok("JWT payload tiene email correcto", payload1.email);
  else                            fail("JWT payload email", JSON.stringify(payload1));

  // ── 2. Descubrir competencias ─────────────────────────────────────────────
  section("2. POST /api/ajustes/descubrir-competencias");
  const { status: descStatus, body: descBody } = await api(
    "/api/ajustes/descubrir-competencias", { method: "POST" }, jwt
  );

  if (descStatus !== 202 || !descBody.jobId) {
    fail("Encolar job", `HTTP ${descStatus} — ${JSON.stringify(descBody)}`);
    process.exit(1);
  }
  ok("Job encolado", `jobId=${descBody.jobId}`);

  // ── 3. Polling ────────────────────────────────────────────────────────────
  section("3. Polling hasta completar");
  const poll = await pollJob(descBody.jobId, jwt);

  if (!poll.ok) {
    fail("Job falló", poll.error);
    process.exit(1);
  }
  const resultado = poll.resultado;
  ok("Job completado", `${resultado?.found ?? 0} competencia(s) encontrada(s), ${resultado?.nuevas ?? 0} nueva(s)`);
  if (resultado?.codigos?.length > 0) {
    console.log(`    Códigos: ${resultado.codigos.join(", ")}`);
  } else {
    console.log("    ⚠  Sin evidencias en DB — ejecuta un autoScan primero desde el Dashboard.");
  }

  // ── 4. Listar competencias ────────────────────────────────────────────────
  section("4. GET /api/competencias");
  const { status: listStatus, body: listBody } = await api("/api/competencias", {}, jwt);

  if (listStatus !== 200 || !Array.isArray(listBody)) {
    fail("Listar competencias", `HTTP ${listStatus} — ${JSON.stringify(listBody)}`);
    process.exit(1);
  }
  ok("Lista recibida", `${listBody.length} competencia(s) en DB`);
  for (const c of listBody) {
    console.log(`    [${c.codigo}]  ${c.nombre}`);
  }

  if (listBody.length === 0) {
    console.log("\n  ⚠  No hay competencias en DB. El flujo de simulación no puede continuar.");
    console.log("     Pasos: Dashboard → Escanear una ficha → volver a correr este smoke test.");
    process.exit(0);
  }

  // ── 5. Simular competencia ────────────────────────────────────────────────
  const compTarget = COMP_ARG || listBody[0].codigo;
  section(`5. POST /api/ajustes/simular-competencia (${compTarget})`);

  const { status: simStatus, body: simBody } = await api(
    "/api/ajustes/simular-competencia",
    { method: "POST", body: JSON.stringify({ competenciaCodigo: compTarget }) },
    jwt
  );

  if (simStatus !== 200 || !simBody.token) {
    fail("Simular", `HTTP ${simStatus} — ${JSON.stringify(simBody)}`);
    process.exit(1);
  }
  ok("Nuevo JWT recibido");
  ok("competenciaCodigo en respuesta", simBody.competenciaCodigo);
  ok("competenciaNombre en respuesta", simBody.competenciaNombre);

  // ── 6. Verificar nuevo JWT ────────────────────────────────────────────────
  section("6. Verificar payload del nuevo JWT");
  const payload2 = decodeJwt(simBody.token);
  if (!payload2) { fail("Decodificar JWT"); }
  else {
    if (payload2.email === EMAIL)                       ok("email",             payload2.email);
    else                                                fail("email en JWT",    payload2.email);
    if (payload2.competenciaCodigo === compTarget)      ok("competenciaCodigo", payload2.competenciaCodigo);
    else                                                fail("competenciaCodigo en JWT", `esperado=${compTarget} obtenido=${payload2.competenciaCodigo}`);
    if (payload2.competenciaNombre === simBody.competenciaNombre) ok("competenciaNombre", payload2.competenciaNombre);
    else                                                fail("competenciaNombre en JWT", payload2.competenciaNombre);
  }

  // ── Resumen ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════════");
  console.log(`  RESULTADO: ${passed} ✅ pasaron  |  ${failed} ❌ fallaron`);
  console.log("═══════════════════════════════════════════════════════════\n");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error("\n❌ Error inesperado:", e.message); process.exit(1); });
