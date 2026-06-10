/**
 * Dispara el descubrimiento REAL de fichas/cursos en Zajuna como el instructor de
 * prueba (instructor.real.test, que reusa las credenciales del superadmin) y muestra
 * lo que aparece, separando programas TÉCNICO vs TECNÓLOGO para poder elegir cuáles
 * escanear a fondo después.
 *
 * Flujo: login API → POST /api/fichas/scan → polling job → GET /api/fichas → tabla.
 *
 * Uso: node scripts/driver-descubrir-fichas.js
 * Requiere: API+workers corriendo, instructor creado con setup-instructor-real.js.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });

const BASE  = "http://localhost:3000";
const EMAIL = "instructor.real.test@zajuna.local";
const PASS  = "Test1234!";

async function api(path, opts = {}, jwt = null) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...opts });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function pollJob(jobId, jwt, maxSecs = 120) {
  const deadline = Date.now() + maxSecs * 1000;
  let last = -1;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const { body } = await api(`/api/jobs/${jobId}`, {}, jwt);
    if (body.progreso !== last) { process.stdout.write(`\r    progreso: ${body.progreso ?? "?"}%   `); last = body.progreso; }
    if (body.status === "done")  { console.log(); return { ok: true,  resultado: body.resultado }; }
    if (body.status === "error") { console.log(); return { ok: false, error: body.errorMsg }; }
  }
  console.log();
  return { ok: false, error: `Timeout (${maxSecs}s)` };
}

// Heurística TÉCNICO vs TECNÓLOGO desde el nombre/programa del curso.
function nivel(txt) {
  const t = (txt || "").toUpperCase();
  if (/TECN[OÓ]LOG/.test(t)) return "TECNÓLOGO";
  if (/T[EÉ]CNIC/.test(t))   return "TÉCNICO";
  return "—";
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  DESCUBRIR FICHAS REALES — instructor.real.test (creds reales)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASS }) });
  if (login.status !== 200 || !login.body.token) { console.error("❌ Login falló:", login.status, login.body); process.exit(1); }
  const jwt = login.body.token;
  console.log("✅ Login OK\n");

  console.log("▸ Disparando POST /api/fichas/scan (login SSO real a Zajuna)...");
  const scan = await api("/api/fichas/scan", { method: "POST" }, jwt);
  if (scan.status !== 202 || !scan.body.jobId) { console.error("❌ No se encoló el scan:", scan.status, scan.body); process.exit(1); }
  console.log(`  job ${scan.body.jobId} encolado. Esperando (esto abre Chromium y entra a Zajuna)...\n`);

  const poll = await pollJob(scan.body.jobId, jwt);
  if (!poll.ok) { console.error("❌ Scan falló:", poll.error); process.exit(1); }

  const fichas = poll.resultado?.fichas || [];
  console.log(`\n✅ Descubrimiento OK — ${fichas.length} ficha(s)/curso(s) con código.\n`);

  // Guardar también lo que quedó en DB (con id) para el siguiente paso
  const enDB = await api("/api/fichas", {}, jwt);
  const lista = Array.isArray(enDB.body) ? enDB.body : (enDB.body?.fichas || []);

  console.log("─".repeat(75));
  console.log("  #  NIVEL       CÓDIGO     COURSE   NOMBRE");
  console.log("─".repeat(75));
  lista.forEach((f, i) => {
    const lvl = nivel(`${f.nombre} ${f.programa}`);
    console.log(`  ${String(i + 1).padStart(2)}  ${lvl.padEnd(10)}  ${String(f.codigo).padEnd(9)}  ${String(f.courseId).padEnd(7)}  ${(f.nombre || "").slice(0, 38)}`);
  });
  console.log("─".repeat(75));
  console.log("\n  Para el siguiente paso, copia el COURSE id (o el #) del técnico y del tecnólogo.\n");
}

main().catch(e => { console.error("❌ Error:", e); process.exit(1); });
