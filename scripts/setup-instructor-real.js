/**
 * Crea (o actualiza) un instructor de PRUEBA que reusa las credenciales de Zajuna
 * del superadmin para poder escanear Moodle de verdad, pero con una competencia
 * NO-inglés. Sirve para probar el flujo real "como si fuera otro instructor".
 *
 * NO desencripta nada: copia tal cual `zajunaUserEnc`/`zajunaPassEnc` del registro
 * del superadmin al nuevo usuario (mismas credenciales SSO → mismo acceso a Zajuna).
 *
 * Uso:
 *   node scripts/setup-instructor-real.js [competenciaCodigo]   # default 220501096
 *   node scripts/setup-instructor-real.js --cleanup             # borra el instructor de prueba y sus datos
 *
 * Credenciales del instructor de prueba (login en la app):
 *   instructor.real.test@zajuna.local / Test1234!
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const bcrypt = require("bcrypt");
const prisma = require("../api/src/db/client");

const SUPERADMIN_EMAIL = "ddiddimmo@gmail.com";
const TEST_EMAIL       = "instructor.real.test@zajuna.local";
const TEST_PASS        = "Test1234!";
const CLEANUP          = process.argv.includes("--cleanup");
const COMP_CODE        = process.argv.find(a => /^\d{9}$/.test(a)) || "220501096";

async function cleanup() {
  const user = await prisma.user.findUnique({ where: { email: TEST_EMAIL } });
  if (!user) { console.log("(no existe el instructor de prueba)"); return; }

  // Borrar datos en orden de FKs
  const fichas = await prisma.ficha.findMany({ where: { userId: user.id }, select: { id: true } });
  const fichaIds = fichas.map(f => f.id);
  const actas = await prisma.actaSeguimiento.findMany({ where: { userId: user.id }, select: { id: true } });
  for (const a of actas) {
    await prisma.actaParticipante.deleteMany({ where: { actaId: a.id } });
    await prisma.actaSeguimiento.delete({ where: { id: a.id } });
  }
  if (fichaIds.length) {
    const evs = await prisma.evidencia.findMany({ where: { fichaId: { in: fichaIds } }, select: { id: true } });
    const evIds = evs.map(e => e.id);
    if (evIds.length) {
      const entregas = await prisma.entrega.findMany({ where: { evidenciaId: { in: evIds } }, select: { id: true } });
      await prisma.historialEstado.deleteMany({ where: { entregaId: { in: entregas.map(e => e.id) } } });
      await prisma.entrega.deleteMany({ where: { evidenciaId: { in: evIds } } });
      await prisma.rapEvidenciaRel.deleteMany({ where: { evidenciaId: { in: evIds } } });
      await prisma.matchingPropuesta.deleteMany({ where: { evidenciaId: { in: evIds } } });
      await prisma.evidencia.deleteMany({ where: { id: { in: evIds } } });
    }
    await prisma.aprendiz.deleteMany({ where: { fichaId: { in: fichaIds } } });
    await prisma.ficha.deleteMany({ where: { id: { in: fichaIds } } });
  }
  await prisma.matchingPropuesta.deleteMany({ where: { userId: user.id } });
  await prisma.job.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } });
  console.log(`🗑 Borrado ${TEST_EMAIL} con sus fichas/evidencias/actas`);
}

async function main() {
  if (CLEANUP) { await cleanup(); await prisma.$disconnect(); return; }

  const admin = await prisma.user.findUnique({ where: { email: SUPERADMIN_EMAIL } });
  if (!admin) { console.error(`No existe ${SUPERADMIN_EMAIL}`); process.exit(1); }

  const comp = await prisma.competencia.findUnique({ where: { codigo: COMP_CODE }, include: { raps: true } });
  if (!comp) { console.error(`No existe la competencia ${COMP_CODE} en DB`); process.exit(1); }

  const passwordHash = await bcrypt.hash(TEST_PASS, 13);

  const data = {
    nombre:            "Instructor Real (técnico/tecnólogo)",
    passwordHash,
    zajunaUserEnc:     admin.zajunaUserEnc,   // ← mismas credenciales Zajuna del superadmin
    zajunaPassEnc:     admin.zajunaPassEnc,
    competenciaCodigo: comp.codigo,
    competenciaNombre: comp.nombre,
    competenciaId:     comp.id,
  };

  const user = await prisma.user.upsert({
    where:  { email: TEST_EMAIL },
    update: data,
    create: { email: TEST_EMAIL, ...data },
  });

  console.log("✅ Instructor de prueba listo:");
  console.log(`   email:       ${TEST_EMAIL}  /  ${TEST_PASS}`);
  console.log(`   userId:      ${user.id}`);
  console.log(`   competencia: ${comp.codigo} — ${comp.nombre.slice(0, 50)} (${comp.raps.length} RAPs)`);
  console.log(`   Zajuna:      credenciales reales del superadmin (copiadas cifradas)`);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
