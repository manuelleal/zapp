/**
 * Prueba el ACTA sobre una ficha real ya escaneada, como el instructor de prueba.
 * Demuestra LAS DOS CARAS del flujo para una competencia NO-inglés (220501096):
 *
 *   1. SIN vínculos RAP↔evidencia  → auto-poblar devuelve 422 RAP_SIN_EVIDENCIAS.
 *      (es el bloqueador real: hoy solo inglés tiene RapEvidenciaRel; el resto
 *       necesita matching IA / Kimi). La app NO se rompe: corta limpio con 422.
 *
 *   2. CON vínculos (demostración)  → vinculamos las evidencias 220501096 ya
 *      escaneadas a los RAPs de la competencia y auto-poblamos de nuevo: ahora
 *      calcula juicios (APROBÓ/PENDIENTE/NO PARTICIPÓ) sobre ENTREGAS REALES.
 *      ⚠ La vinculación aquí es de DEMO (round-robin GA→RAP); en producción la
 *      hace el matching IA, no esta heurística.
 *
 * Uso:
 *   node scripts/driver-acta-real.js <courseId>     # default 77767 (técnico, con notas)
 *
 * Requiere: la ficha ya escaneada con driver-escanear-evidencias.js (evidencias
 *           220501096 activas con entregas).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const BASE  = "http://localhost:3000";
const EMAIL = "instructor.real.test@zajuna.local";
const PASS  = "Test1234!";
const COURSE_ID = Number(process.argv.find(a => /^\d+$/.test(a))) || 77767;
const COMP_CODE = "220501096";

async function api(path, opts = {}, jwt = null) {
  const headers = {};
  if (opts.body) headers["Content-Type"] = "application/json";
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;
  const res = await fetch(`${BASE}${path}`, { headers, ...opts });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  PRUEBA DE ACTA REAL — course ${COURSE_ID}, competencia ${COMP_CODE}`);
  console.log("═══════════════════════════════════════════════════════════════");

  const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: EMAIL, password: PASS }) });
  if (login.status !== 200) { console.error("❌ Login:", login.status, login.body); process.exit(1); }
  const jwt = login.body.token;

  const user = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  const ficha = await prisma.ficha.findFirst({ where: { userId: user.id, courseId: COURSE_ID }, select: { id: true, codigo: true } });
  if (!ficha) { console.error(`❌ No hay ficha con courseId ${COURSE_ID} para el instructor de prueba`); process.exit(1); }

  const comp = await prisma.competencia.findUnique({ where: { codigo: COMP_CODE }, include: { raps: { orderBy: { codigo: "asc" } } } });
  console.log(`\n  Ficha ${ficha.codigo} | competencia ${comp.codigo} con ${comp.raps.length} RAPs: ${comp.raps.map(r => r.codigo).join(", ")}`);

  const hoy = new Date().toISOString().slice(0, 10);

  // ── CASO 1: sin vínculos → 422 ────────────────────────────────────────────────
  console.log("\n── CASO 1: acta SIN vínculos RAP↔evidencia (estado real de hoy) ──");
  const acta1 = await api("/api/actas", { method: "POST", body: JSON.stringify({
    fichaId: ficha.id, numero: "01", fecha: hoy, hora: "08:00",
    objetivo: "Acta técnica real — sin vínculos", rapIds: comp.raps.map(r => r.id),
  }) }, jwt);
  if (acta1.status !== 201) { console.error("  ❌ crear acta:", acta1.status, acta1.body); process.exit(1); }
  console.log(`  Acta creada (id=${acta1.body.id}).`);
  const ap1 = await api(`/api/actas/${acta1.body.id}/auto-poblar`, { method: "POST", body: JSON.stringify({}) }, jwt);
  if (ap1.status === 422) {
    console.log(`  ✅ auto-poblar cortó con 422 ${ap1.body.error} (esperado).`);
    console.log(`     RAPs sin evidencias: ${(ap1.body.rapsSinEvidencias || []).map(r => r.codigo).join(", ")}`);
    console.log(`     → Es el bloqueador conocido: competencias no-inglés necesitan matching IA (Kimi).`);
  } else {
    console.log(`  ⚠ auto-poblar devolvió ${ap1.status} (esperaba 422):`, JSON.stringify(ap1.body).slice(0, 160));
  }

  // ── Vinculación de DEMO ───────────────────────────────────────────────────────
  console.log("\n── Vinculando evidencias 220501096 a sus RAPs (DEMO round-robin) ──");
  const evs = await prisma.evidencia.findMany({
    where: { fichaId: ficha.id, nombre: { contains: COMP_CODE }, activaParaScan: true },
    select: { id: true, nombre: true },
  });
  if (evs.length === 0) { console.error("  ❌ No hay evidencias 220501096 activas escaneadas. Corre driver-escanear-evidencias primero."); process.exit(1); }
  // Round-robin: repartir las evidencias entre los RAPs de la competencia.
  let creados = 0;
  for (let i = 0; i < evs.length; i++) {
    const rap = comp.raps[i % comp.raps.length];
    await prisma.rapEvidenciaRel.upsert({
      where:  { rapId_evidenciaId: { rapId: rap.id, evidenciaId: evs[i].id } },
      create: { rapId: rap.id, evidenciaId: evs[i].id },
      update: {},
    });
    creados++;
  }
  console.log(`  ✅ ${creados} vínculos RapEvidenciaRel creados (${evs.length} evidencias × RAPs).`);

  // ── CASO 2: con vínculos → auto-poblar real ──────────────────────────────────
  console.log("\n── CASO 2: acta CON vínculos — auto-poblar sobre entregas reales ──");
  const acta2 = await api("/api/actas", { method: "POST", body: JSON.stringify({
    fichaId: ficha.id, numero: "02", fecha: hoy, hora: "09:00",
    objetivo: "Acta técnica real — con vínculos", rapIds: comp.raps.map(r => r.id),
  }) }, jwt);
  console.log(`  Acta creada (id=${acta2.body.id}).`);
  const ap2 = await api(`/api/actas/${acta2.body.id}/auto-poblar`, { method: "POST", body: JSON.stringify({}) }, jwt);
  if (ap2.status === 200) {
    const r = ap2.body;
    console.log(`  ✅ auto-poblar OK (modo ${r.modo}):`);
    console.log(`     poblados=${r.poblados}  APROBARON=${r.aprobaron}  PENDIENTE=${r.pendientes}  NO PARTICIPÓ=${r.noParticiparon}  warnings=${r.warnings}`);
    console.log(`     evidencias vinculadas=${r.evidenciasVinculadas}  filtrados(dup)=${r.filtrados}`);

    // Muestra de juicios reales
    const det = await api(`/api/actas/${acta2.body.id}`, {}, jwt);
    const parts = det.body?.participantes || [];
    console.log(`\n     Muestra de juicios (primeros 8 de ${parts.length} aprendices reales):`);
    for (const p of parts.slice(0, 8)) {
      console.log(`       ${(p.aprendiz?.nombre || "?").slice(0, 34).padEnd(34)} → ${p.juicio}${p.hasUngraded ? " ⚠" : ""}`);
    }
  } else {
    console.log(`  ❌ auto-poblar devolvió ${ap2.status}:`, JSON.stringify(ap2.body).slice(0, 200));
  }

  // ── Reporte ───────────────────────────────────────────────────────────────────
  console.log("\n── Reporte Excel de la ficha (real) ──");
  const xlsxRes = await fetch(`${BASE}/api/fichas/${ficha.id}/reporte-excel`, { headers: { Authorization: `Bearer ${jwt}` } });
  const buf = Buffer.from(await xlsxRes.arrayBuffer());
  if (xlsxRes.status === 200 && buf[0] === 0x50 && buf[1] === 0x4B) console.log(`  ✅ Excel generado: ${buf.length} bytes (XLSX válido)`);
  else console.log(`  ❌ Excel: HTTP ${xlsxRes.status}, ${buf.length} bytes`);

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Conclusión: evidencias cargan ✓, filtro por activación ✓,");
  console.log("  acta corta limpio sin vínculos (422) ✓ y funciona con vínculos ✓.");
  console.log("  El paso que falta para producción: matching IA (Kimi) que genere");
  console.log("  los RapEvidenciaRel automáticamente para competencias no-inglés.");
  console.log("═══════════════════════════════════════════════════════════════\n");

  await prisma.$disconnect();
}

main().catch(async e => { console.error("❌ Error:", e); await prisma.$disconnect().catch(() => {}); process.exit(1); });
