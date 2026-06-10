/**
 * Test POST-MORTEM del flujo completo de un instructor, de punta a punta.
 *
 * Los instructores de prueba (creados por test-multitenant.js) tienen credenciales
 * Zajuna FICTICIAS → no pueden escanear Moodle real. Por eso este script SIEMBRA en
 * DB el estado que dejaría un scan (ficha + evidencias activas + aprendices +
 * entregas con notas + RapEvidenciaRel), y luego ejerce TODO el flujo VÍA HTTP,
 * exactamente como el browser del instructor:
 *
 *   1. CARGAR EVIDENCIAS   GET /api/evidencias/todas         (vista de evidencias)
 *   2. IR A CALIFICAR      GET /api/evidencias/:id/entregas  (lista de aprendices)
 *                          PATCH /api/evidencias/:id/estado  (marcar "calificando")
 *   3. DASHBOARD           GET /api/evidencias/activas       (tarjetas con contadores)
 *   4. ACTUALIZAR          (simula que un re-scan encontró una nota nueva: muta 1
 *                          entrega pendiente→calificado en DB) → re-GET activas y
 *                          verifica que el contador de pendientes BAJÓ.
 *   5. ACTA                POST /api/actas → POST :id/auto-poblar (ahora SÍ puebla,
 *                          modo per-rap, porque sembramos RapEvidenciaRel) →
 *                          verifica juicios (APROBÓ / PENDIENTE / NO PARTICIPÓ).
 *   6. REPORTES            GET /api/fichas/:id/reporte-pendientes (CSV)
 *                          GET /api/fichas/:id/reporte-excel      (XLSX binario)
 *
 * Escenario sembrado (4 aprendices × 3 evidencias activas, 3 RAPs de la competencia):
 *   - Ana   : todo calificado y aprobado (≥70)        → debe dar APROBÓ
 *   - Beto  : una pendiente sin nota                  → debe dar PENDIENTE
 *   - Caro  : una entrega reprobada (40)              → debe dar PENDIENTE
 *   - Diego : sin ninguna entrega                     → debe dar NO PARTICIPÓ
 *
 * Uso:
 *   node scripts/test-flujo-completo.js            # siembra + corre el flujo (limpia su propia siembra al final)
 *   node scripts/test-flujo-completo.js --keep     # igual, pero conserva los datos para mirarlos en el browser
 *   node scripts/test-flujo-completo.js --cleanup  # solo borra la siembra post-mortem y sale
 *
 * Requiere: API en localhost:3000 + el usuario instructor1.test@zajuna.local
 *           (créalo antes con: node scripts/test-multitenant.js).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const BASE      = "http://localhost:3000";
const INSTRUCTOR = { email: "instructor1.test@zajuna.local", password: "Test1234!", competenciaCodigo: "220501096" };
const FICHA_COD = "POSTMORTEM-220501096";
const KEEP      = process.argv.includes("--keep");
const CLEANUP   = process.argv.includes("--cleanup");

let passed = 0, failed = 0;
function ok(label, detail = "")   { passed++; console.log(`  ✅ ${label}${detail ? "  →  " + detail : ""}`); }
function fail(label, detail = "") { failed++; console.log(`  ❌ ${label}${detail ? "  →  " + detail : ""}`); }
function section(title)           { console.log(`\n── ${title} ${"─".repeat(Math.max(0, 58 - title.length))}`); }

async function api(path, opts = {}, jwt = null) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...opts });
  const ct  = res.headers.get("content-type") || "";
  let body;
  if (ct.includes("application/json")) body = await res.json().catch(() => ({}));
  else body = await res.arrayBuffer().then(b => Buffer.from(b)).catch(() => null); // CSV / XLSX
  return { status: res.status, body, contentType: ct };
}

// ─── Borrar siembra previa (idempotencia) ─────────────────────────────────────

async function borrarSiembra(userId) {
  const ficha = await prisma.ficha.findUnique({ where: { userId_codigo: { userId, codigo: FICHA_COD } } });
  if (!ficha) return false;

  // Orden de FKs: participantes/actas → entregas/rels → evidencias → aprendices → ficha
  const actas = await prisma.actaSeguimiento.findMany({ where: { fichaId: ficha.id }, select: { id: true } });
  for (const a of actas) {
    await prisma.actaParticipante.deleteMany({ where: { actaId: a.id } });
    await prisma.actaSeguimiento.delete({ where: { id: a.id } });
  }
  const evs = await prisma.evidencia.findMany({ where: { fichaId: ficha.id }, select: { id: true } });
  const evIds = evs.map(e => e.id);
  if (evIds.length) {
    const entregas = await prisma.entrega.findMany({ where: { evidenciaId: { in: evIds } }, select: { id: true } });
    await prisma.historialEstado.deleteMany({ where: { entregaId: { in: entregas.map(e => e.id) } } });
    await prisma.entrega.deleteMany({ where: { evidenciaId: { in: evIds } } });
    await prisma.rapEvidenciaRel.deleteMany({ where: { evidenciaId: { in: evIds } } });
    await prisma.matchingPropuesta.deleteMany({ where: { evidenciaId: { in: evIds } } });
    await prisma.evidencia.deleteMany({ where: { id: { in: evIds } } });
  }
  await prisma.aprendiz.deleteMany({ where: { fichaId: ficha.id } });
  await prisma.ficha.delete({ where: { id: ficha.id } });
  return true;
}

// ─── Sembrar el escenario (lo que dejaría un scan real) ───────────────────────

async function sembrar(userId, comp) {
  await borrarSiembra(userId); // empezar limpio

  const ficha = await prisma.ficha.create({
    data: { userId, codigo: FICHA_COD, courseId: 88888, nombre: "Ficha post-mortem (datos sembrados)", programa: "Prueba E2E" },
  });

  // 3 evidencias activas, una por cada uno de los primeros 3 RAPs de la competencia.
  const raps = comp.raps.slice(0, 3);
  const evidencias = [];
  for (let i = 0; i < raps.length; i++) {
    const n = i + 1;
    const ev = await prisma.evidencia.create({
      data: {
        fichaId: ficha.id,
        nombre:  `GA${n}-${comp.codigo}-AA1-EV0${n} Evidencia sembrada ${n}`,
        href:    `https://zajuna.sena.edu.co/mod/assign/view.php?id=${900000 + n}`,
        tipo:    "assign",
        activaParaScan: true,
      },
    });
    // Vincular evidencia → RAP (lo que hace vincularEvidenciasRAPs / matching aceptado)
    await prisma.rapEvidenciaRel.create({ data: { rapId: raps[i].id, evidenciaId: ev.id } });
    evidencias.push(ev);
  }

  const aprendices = {};
  for (const nombre of ["ANA PEREZ", "BETO GOMEZ", "CARO DIAZ", "DIEGO RUIZ"]) {
    aprendices[nombre] = await prisma.aprendiz.create({
      data: { fichaId: ficha.id, nombre, moodleId: String(1000 + Object.keys(aprendices).length) },
    });
  }

  // Entregas: el corazón del escenario (ver cabecera). estado/nota por aprendiz×evidencia.
  // Ana: 3 calificadas aprobadas. Beto: 2 calificadas + 1 pendiente. Caro: 1 reprobada
  // (40) + 2 aprobadas. Diego: sin entregas (NO PARTICIPÓ).
  const plan = {
    "ANA PEREZ":  [["calificado", 90], ["calificado", 85], ["calificado", 78]],
    "BETO GOMEZ": [["calificado", 80], ["calificado", 75], ["pendiente", null]],
    "CARO DIAZ":  [["calificado", 40], ["calificado", 88], ["calificado", 92]],
    "DIEGO RUIZ": [], // sin entregas
  };

  for (const [nombre, entregas] of Object.entries(plan)) {
    for (let i = 0; i < entregas.length; i++) {
      const [estado, nota] = entregas[i];
      await prisma.entrega.create({
        data: {
          evidenciaId: evidencias[i].id,
          aprendizId:  aprendices[nombre].id,
          estado,
          notaActual:  nota,
          fechaScan:   new Date(),
        },
      });
    }
  }

  return { ficha, evidencias, aprendices };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  TEST POST-MORTEM — flujo completo del instructor (E2E)");
  console.log("═══════════════════════════════════════════════════════════════");

  const user = await prisma.user.findUnique({ where: { email: INSTRUCTOR.email } });
  if (!user) {
    console.log(`\n  ❌ No existe ${INSTRUCTOR.email}. Créalo primero:`);
    console.log(`     node scripts/test-multitenant.js\n`);
    await prisma.$disconnect();
    process.exit(1);
  }

  if (CLEANUP) {
    section("Cleanup de la siembra post-mortem");
    const had = await borrarSiembra(user.id);
    console.log(had ? `  🗑 Borrada la ficha ${FICHA_COD} y sus datos` : `  (no había siembra que borrar)`);
    await prisma.$disconnect();
    return;
  }

  // ── 0. Login + siembra ──────────────────────────────────────────────────────
  section("0. Login + siembra del escenario");
  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: INSTRUCTOR.email, password: INSTRUCTOR.password }) });
  if (login.status !== 200 || !login.body.token) { fail("Login instructor", `HTTP ${login.status} — ${JSON.stringify(login.body)}`); process.exit(1); }
  const jwt = login.body.token;
  ok("Login instructor de prueba");

  const comp = await prisma.competencia.findUnique({ where: { codigo: INSTRUCTOR.competenciaCodigo }, include: { raps: { orderBy: { codigo: "asc" }, select: { id: true, codigo: true } } } });
  if (!comp || comp.raps.length < 3) { fail("Competencia con ≥3 RAPs", `${comp?.raps.length ?? 0} RAPs`); process.exit(1); }

  const sembrado = await sembrar(user.id, comp);
  ok("Escenario sembrado", `1 ficha, 3 evidencias, 4 aprendices, RAPs ${comp.raps.slice(0,3).map(r => r.codigo).join("/")}`);

  // ── 1. Cargar evidencias ────────────────────────────────────────────────────
  section("1. CARGAR EVIDENCIAS — GET /api/evidencias/todas");
  const todas = await api("/api/evidencias/todas", {}, jwt);
  const fichaTodas = (todas.body?.fichas || []).find(f => f.codigo === FICHA_COD);
  if (!fichaTodas) { fail("Ficha sembrada aparece en /todas"); }
  else {
    ok("Ficha aparece con sus evidencias", `${fichaTodas.evidencias.length} evidencias`);
    const evAna = fichaTodas.evidencias[0];
    // Evidencia 1: Ana(90) Beto(80) Caro(40) los 3 calificados → calificados=3, pendientes=0
    if (evAna.calificados === 3 && evAna.pendientes === 0) ok("Contadores evidencia 1 correctos", `calif=${evAna.calificados} pend=${evAna.pendientes}`);
    else fail("Contadores evidencia 1", `calif=${evAna.calificados} pend=${evAna.pendientes} (esperado 3/0)`);
    // Evidencia 3: solo Ana(78) Caro(92) calificadas, Beto pendiente, Diego nada
    const ev3 = fichaTodas.evidencias[2];
    if (ev3.pendientes === 1) ok("Evidencia 3 tiene 1 pendiente (Beto)", `pend=${ev3.pendientes}`);
    else fail("Evidencia 3 pendientes", `pend=${ev3.pendientes} (esperado 1)`);
  }

  // ── 2. Ir a calificar ───────────────────────────────────────────────────────
  section("2. IR A CALIFICAR — entregas + marcar 'calificando'");
  const evParaCalificar = fichaTodas.evidencias[2]; // la que tiene un pendiente
  const ent = await api(`/api/evidencias/${evParaCalificar.id}/entregas`, {}, jwt);
  const listaEnt = ent.body?.entregas || ent.body?.aprendices || (Array.isArray(ent.body) ? ent.body : null);
  if (ent.status === 200 && Array.isArray(listaEnt)) {
    ok("Lista de entregas/aprendices cargada", `${listaEnt.length} filas`);
    const pendiente = listaEnt.find(x => (x.estado || "").toLowerCase() === "pendiente");
    if (pendiente) ok("Aprendiz pendiente visible para calificar", pendiente.aprendiz?.nombre || pendiente.nombre || "?");
    else fail("No se ve el aprendiz pendiente en la lista");
  } else fail("GET entregas", `HTTP ${ent.status} — ${JSON.stringify(ent.body).slice(0,120)}`);

  const marcar = await api(`/api/evidencias/${evParaCalificar.id}/estado`, { method: "PATCH", body: JSON.stringify({ calificando: true }) }, jwt);
  if (marcar.status === 200 && marcar.body.calificandoAt) ok("Evidencia marcada como 'calificando'");
  else fail("Marcar calificando", `HTTP ${marcar.status} — ${JSON.stringify(marcar.body)}`);

  // ── 3. Dashboard ────────────────────────────────────────────────────────────
  section("3. DASHBOARD — GET /api/evidencias/activas");
  const activas1 = await api("/api/evidencias/activas", {}, jwt);
  const fichaAct1 = (activas1.body?.fichas || []).find(f => f.codigo === FICHA_COD);
  let pendAntes = null;
  if (fichaAct1) {
    pendAntes = fichaAct1.evidencias.reduce((s, e) => s + e.pendientes, 0);
    ok("Dashboard muestra la ficha activa", `${fichaAct1.evidencias.length} evidencias, ${pendAntes} pendiente(s) en total`);
    const marcada = fichaAct1.evidencias.find(e => e.id === evParaCalificar.id);
    if (marcada?.calificandoAt) ok("La evidencia aparece en estado 'calificando' en el dashboard");
    else fail("calificandoAt no se refleja en el dashboard");
  } else fail("Dashboard no muestra la ficha activa");

  // ── 4. Actualizar (simula re-scan que encontró una nota nueva) ──────────────
  section("4. ACTUALIZAR — re-scan encuentra nota nueva, dashboard refleja");
  // El instructor calificó a Beto en Moodle; el siguiente scan lo traería como
  // calificado. Lo simulamos mutando la entrega pendiente → calificado(82) en DB.
  const entregaBeto = await prisma.entrega.findFirst({
    where: { evidenciaId: evParaCalificar.id, estado: "pendiente" },
  });
  if (entregaBeto) {
    await prisma.entrega.update({ where: { id: entregaBeto.id }, data: { estado: "calificado", notaActual: 82, fechaScan: new Date() } });
    ok("Simulado: entrega pendiente → calificado(82) (como tras un re-scan)");
  } else fail("No se encontró la entrega pendiente a actualizar");

  const activas2 = await api("/api/evidencias/activas", {}, jwt);
  const fichaAct2 = (activas2.body?.fichas || []).find(f => f.codigo === FICHA_COD);
  const pendDespues = fichaAct2 ? fichaAct2.evidencias.reduce((s, e) => s + e.pendientes, 0) : null;
  if (pendDespues !== null && pendAntes !== null && pendDespues === pendAntes - 1) {
    ok("El dashboard refleja la actualización", `pendientes ${pendAntes} → ${pendDespues}`);
  } else fail("El contador de pendientes no bajó tras actualizar", `antes=${pendAntes} después=${pendDespues}`);

  // ── 5. Acta — crear + auto-poblar (modo per-rap, ahora SÍ funciona) ─────────
  section("5. ACTA — crear + auto-poblar (modo per-rap)");
  const hoy = new Date().toISOString().slice(0, 10);
  const acta = await api("/api/actas", { method: "POST", body: JSON.stringify({
    fichaId: sembrado.ficha.id, numero: "01", fecha: hoy, hora: "09:00",
    objetivo: "Acta post-mortem E2E", rapIds: comp.raps.slice(0, 3).map(r => r.id),
  }) }, jwt);
  if (acta.status !== 201) { fail("Crear acta", `HTTP ${acta.status} — ${JSON.stringify(acta.body).slice(0,150)}`); }
  else {
    ok("Acta creada", `id=${acta.body.id}`);
    const ap = await api(`/api/actas/${acta.body.id}/auto-poblar`, { method: "POST", body: JSON.stringify({}) }, jwt);
    if (ap.status === 200) {
      const r = ap.body;
      ok("auto-poblar OK (modo " + r.modo + ")", `poblados=${r.poblados} aprob=${r.aprobaron} pend=${r.pendientes} noPart=${r.noParticiparon}`);
      // Cada RAP tiene 1 evidencia (RAP1→ev1, RAP2→ev2, RAP3→ev3), así que el juicio
      // de cada aprendiz es "aprobó las 3 evidencias". Estado DESPUÉS del paso 4
      // (la pendiente de Beto ya pasó a calificado 82):
      //   Ana   90/85/78  → APROBÓ
      //   Beto  80/75/82  → APROBÓ  (subió en el re-scan del paso 4)
      //   Caro  40/88/92  → PENDIENTE (el 40 < 70 reprueba el RAP1)
      //   Diego sin nada  → NO PARTICIPÓ
      if (r.modo === "per-rap")        ok("Modo per-rap (RapEvidenciaRel sembrado funciona)");
      else                             fail("Modo no es per-rap", r.modo);
      if (r.aprobaron === 2)           ok("2 aprendices APROBARON (Ana, Beto)");
      else                             fail("Aprobaron", `${r.aprobaron} (esperado 2: Ana+Beto)`);
      if (r.noParticiparon === 1)      ok("1 aprendiz NO PARTICIPÓ (Diego)");
      else                             fail("NoParticiparon", `${r.noParticiparon} (esperado 1: Diego)`);
      if (r.pendientes === 1)          ok("1 aprendiz PENDIENTE (Caro, por el 40)");
      else                             fail("Pendientes", `${r.pendientes} (esperado 1: Caro)`);
    } else fail("auto-poblar", `HTTP ${ap.status} — ${JSON.stringify(ap.body).slice(0,200)}`);
  }

  // ── 6. Reportes ──────────────────────────────────────────────────────────────
  section("6. REPORTES — CSV pendientes + Excel");
  const csv = await api(`/api/fichas/${sembrado.ficha.id}/reporte-pendientes`, {}, jwt);
  if (csv.status === 200 && csv.body && Buffer.isBuffer(csv.body) && csv.body.length > 0) {
    const txt = csv.body.toString("utf8");
    if (txt.includes("ANA PEREZ") && txt.includes("Calificado")) ok("CSV de pendientes generado", `${csv.body.length} bytes`);
    else fail("CSV sin contenido esperado", txt.slice(0, 80));
  } else fail("reporte-pendientes", `HTTP ${csv.status}`);

  const xlsx = await api(`/api/fichas/${sembrado.ficha.id}/reporte-excel`, {}, jwt);
  // XLSX = ZIP → empieza con "PK" (0x50 0x4B)
  if (xlsx.status === 200 && Buffer.isBuffer(xlsx.body) && xlsx.body[0] === 0x50 && xlsx.body[1] === 0x4B) {
    ok("Excel generado (XLSX válido)", `${xlsx.body.length} bytes`);
  } else fail("reporte-excel", `HTTP ${xlsx.status} — ${xlsx.body?.length ?? 0} bytes, ct=${xlsx.contentType}`);

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  if (!KEEP) {
    await borrarSiembra(user.id);
    console.log("\n  🗑 Siembra post-mortem borrada (usa --keep para conservarla).");
  } else {
    console.log(`\n  📌 Siembra CONSERVADA (--keep). Entra al browser como ${INSTRUCTOR.email} / ${INSTRUCTOR.password}`);
    console.log(`     Ficha: ${FICHA_COD}. Para borrarla: node scripts/test-flujo-completo.js --cleanup`);
  }

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log(`  RESULTADO: ${passed} ✅ pasaron  |  ${failed} ❌ fallaron`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async e => { console.error("\n❌ Error inesperado:", e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
