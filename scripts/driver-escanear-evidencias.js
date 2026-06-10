/**
 * Escanea evidencias REALES de uno o más cursos como el instructor de prueba
 * (instructor.real.test, creds reales del superadmin) reproduciendo el flujo de la
 * UI de punta a punta:
 *
 *   FASE A  Discovery   POST /api/fichas/:id/evidencias/scan  → registra evidencias
 *   (ver)               GET  /api/fichas/:id/evidencias       → lista por competencia
 *   FASE B  Activar      PATCH /api/evidencias/activar/bulk    → activa un subconjunto
 *   FASE C  Re-scan      POST .../evidencias/scan (otra vez)   → raspa entregas reales
 *   (ver)               GET  .../evidencias                    → conteos calif/pend/sin
 *
 * El objetivo es comprobar con datos reales: que las evidencias CARGAN, que el
 * FILTRO por activación funciona (solo las activas traen entregas), y dejar la
 * ficha lista para probar el acta.
 *
 * Uso:
 *   node scripts/driver-escanear-evidencias.js <courseId> [courseId2 ...]
 *   node scripts/driver-escanear-evidencias.js 51083 77767
 *
 * Opcional:
 *   --activar=GA           activa las evidencias cuyo nombre contiene "GA" (default)
 *   --activar=220501096    activa solo las de esa competencia
 *   --max=8                máximo de evidencias a activar por ficha (default 6)
 *   --no-entregas          solo discovery (no activa ni re-escanea)
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const BASE  = "http://localhost:3000";
const EMAIL = "instructor.real.test@zajuna.local";
const PASS  = "Test1234!";

const COURSE_IDS = process.argv.slice(2).filter(a => /^\d+$/.test(a)).map(Number);
const FILTRO     = (process.argv.find(a => a.startsWith("--activar=")) || "--activar=GA").split("=")[1];
const MAX_ACT    = Number((process.argv.find(a => a.startsWith("--max=")) || "--max=6").split("=")[1]);
const NO_ENTREGAS = process.argv.includes("--no-entregas");

if (COURSE_IDS.length === 0) { console.error("Pasa al menos un courseId. Ej: node scripts/driver-escanear-evidencias.js 51083 77767"); process.exit(1); }

async function api(path, opts = {}, jwt = null) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...opts });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function pollJob(jobId, jwt, maxSecs = 240) {
  const deadline = Date.now() + maxSecs * 1000;
  let last = -1;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2500));
    const { body } = await api(`/api/jobs/${jobId}`, {}, jwt);
    if (body.progreso !== last) { process.stdout.write(`\r      progreso: ${body.progreso ?? "?"}%   `); last = body.progreso; }
    if (body.status === "done")  { console.log(); return { ok: true,  resultado: body.resultado }; }
    if (body.status === "error") { console.log(); return { ok: false, error: body.errorMsg }; }
  }
  console.log();
  return { ok: false, error: `Timeout (${maxSecs}s)` };
}

// Extrae el código de competencia (9 dígitos) del nombre de la evidencia.
function compDe(nombre) {
  const m = (nombre || "").match(/\b(\d{9})\b/);
  return m ? m[1] : "(sin código)";
}

function resumirPorCompetencia(evidencias) {
  const porComp = new Map();
  for (const ev of evidencias) {
    const c = compDe(ev.nombre);
    porComp.set(c, (porComp.get(c) || 0) + 1);
  }
  return [...porComp.entries()].sort((a, b) => b[1] - a[1]);
}

async function escanearCurso(jwt, ficha) {
  console.log(`\n╔══ Ficha ${ficha.codigo} (course ${ficha.courseId}) — ${(ficha.nombre || "").slice(0, 40)}`);

  // ── FASE A: Discovery ────────────────────────────────────────────────────────
  console.log("  ▸ FASE A: Discovery (descubrir evidencias)...");
  const scanA = await api(`/api/fichas/${ficha.id}/evidencias/scan`, { method: "POST" }, jwt);
  if (scanA.status !== 202) { console.log(`    ❌ scan no encolado: ${scanA.status} ${JSON.stringify(scanA.body)}`); return; }
  const pollA = await pollJob(scanA.body.jobId, jwt);
  if (!pollA.ok) { console.log(`    ❌ discovery falló: ${pollA.error}`); return; }

  const evA = await api(`/api/fichas/${ficha.id}/evidencias?incluirCerradas=1`, {}, jwt);
  const evidencias = evA.body?.evidencias || [];
  console.log(`    ✅ ${evidencias.length} evidencias descubiertas. Por competencia:`);
  for (const [comp, n] of resumirPorCompetencia(evidencias)) console.log(`        ${comp}: ${n}`);

  if (NO_ENTREGAS || evidencias.length === 0) return;

  // ── FASE B: Activar un subconjunto (filtro) ──────────────────────────────────
  const candidatas = evidencias.filter(ev => (ev.nombre || "").includes(FILTRO)).slice(0, MAX_ACT);
  if (candidatas.length === 0) {
    console.log(`  ⚠ Ninguna evidencia coincide con --activar=${FILTRO}; no se activa nada.`);
    return;
  }
  console.log(`  ▸ FASE B: Activando ${candidatas.length} evidencias (filtro "${FILTRO}")...`);
  const act = await api("/api/evidencias/activar/bulk", { method: "PATCH", body: JSON.stringify({ ids: candidatas.map(e => e.id), activa: true }) }, jwt);
  console.log(act.status === 200 ? `    ✅ ${act.body.actualizadas} activadas` : `    ❌ activar: ${act.status} ${JSON.stringify(act.body)}`);

  // ── FASE C: Re-scan (entregas reales de las activas) ─────────────────────────
  console.log("  ▸ FASE C: Re-scan (raspar entregas de las activas)...");
  const scanC = await api(`/api/fichas/${ficha.id}/evidencias/scan`, { method: "POST" }, jwt);
  const pollC = await pollJob(scanC.body.jobId, jwt);
  if (!pollC.ok) { console.log(`    ❌ re-scan falló: ${pollC.error}`); return; }

  const evC = await api(`/api/fichas/${ficha.id}/evidencias`, {}, jwt);
  const activas = (evC.body?.evidencias || []).filter(e => e.total > 0 || candidatas.some(c => c.id === e.id));
  console.log(`    ✅ Entregas raspadas. Detalle de las activas:`);
  for (const ev of activas) {
    console.log(`        [${compDe(ev.nombre)}] ${(ev.nombre || "").slice(0, 42).padEnd(42)}  calif=${ev.calificados}  pend=${ev.pendientes}  sin=${ev.sinEntregar}  (tot ${ev.total})`);
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ESCANEAR EVIDENCIAS REALES — instructor.real.test");
  console.log(`  Cursos objetivo: ${COURSE_IDS.join(", ")}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASS }) });
  if (login.status !== 200) { console.error("❌ Login:", login.status, login.body); process.exit(1); }
  const jwt = login.body.token;

  const enDB = await api("/api/fichas", {}, jwt);
  const lista = Array.isArray(enDB.body) ? enDB.body : (enDB.body?.fichas || []);

  for (const cid of COURSE_IDS) {
    const ficha = lista.find(f => f.courseId === cid);
    if (!ficha) { console.log(`\n⚠ No hay ficha con courseId ${cid} (¿corriste el descubrimiento?)`); continue; }
    await escanearCurso(jwt, ficha);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Listo. Siguiente: armar acta sobre una de estas fichas.");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(e => { console.error("❌ Error:", e); process.exit(1); });
