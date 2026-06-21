/**
 * scripts/diag-raps.js — Diagnóstico de por qué la página RAPs sale vacía.
 *
 * Pinta el estado real de la DB (la que apunte DATABASE_URL del .env) para los
 * datos que alimentan `GET /api/raps`:
 *   - Conteos globales (Competencia / RAP / Criterio / RapEvidenciaRel).
 *   - Cada Competencia con su id (cuid), código y nº de RAPs.
 *   - Cada usuario: competenciaCodigo (estable) vs competenciaId (cuid, volátil),
 *     y CUÁNTOS RAPs ve hoy el endpoint (filtra por competenciaId) vs cuántos
 *     DEBERÍA ver si se resolviera por código.
 *
 * Por qué importa: `GET /api/raps` (api/src/routes/raps.js → getCompetenciaId)
 * filtra los RAPs por `user.competenciaId`, que es un FK al cuid de Competencia.
 * Si las competencias se re-sembraron (nuevos cuid) ese FK queda OBSOLETO y el
 * endpoint devuelve [] aunque los RAPs existan bajo el mismo `codigo`. Si está en
 * null devuelve 422. Las dos cosas pintan "No hay RAPs para tu competencia".
 *
 * Uso (en el servidor, dentro de /opt/helper, sin reiniciar la app):
 *   node scripts/diag-raps.js
 *   node scripts/diag-raps.js correo@ejemplo.com   # filtra un usuario
 *
 * Read-only: NO escribe nada en la DB.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

async function main() {
  const filtroEmail = process.argv[2] || null;

  // ── Conteos globales ───────────────────────────────────────────────────────
  const [nComp, nRap, nCrit, nRel, nUser] = await Promise.all([
    prisma.competencia.count(),
    prisma.rAP.count(),
    prisma.criterio.count(),
    prisma.rapEvidenciaRel.count(),
    prisma.user.count(),
  ]);
  console.log("── CONTEOS GLOBALES (DB de", process.env.DATABASE_URL?.split("@")[1] || "?", ") ──");
  console.log("  Competencias    :", nComp);
  console.log("  RAPs            :", nRap);
  console.log("  Criterios       :", nCrit);
  console.log("  RapEvidenciaRel :", nRel);
  console.log("  Usuarios        :", nUser);

  if (nRap === 0) {
    console.log("\n  🔴 La DB NO tiene NINGÚN RAP. Por eso TODOS los instructores ven la página vacía.");
    console.log("     → Hay que CARGAR los RAPs en esta base (no es problema de un usuario).");
  }

  // ── Competencias con su id (cuid) y nº de RAPs ─────────────────────────────
  const comps = await prisma.competencia.findMany({
    select: { id: true, codigo: true, nombre: true, _count: { select: { raps: true } } },
    orderBy: { codigo: "asc" },
  });
  console.log("\n── COMPETENCIAS EN DB (", comps.length, ") ──");
  for (const c of comps) {
    console.log(
      ` ${c.codigo}  raps=${String(c._count.raps).padStart(3)}  id=${c.id}  ${c.nombre.substring(0, 45)}`
    );
  }

  // ── Usuarios: ¿su competenciaId apunta a algo con RAPs? ─────────────────────
  const users = await prisma.user.findMany({
    where: filtroEmail ? { email: filtroEmail } : undefined,
    select: { email: true, rol: true, competenciaCodigo: true, competenciaId: true, competenciaNombre: true },
    orderBy: { email: "asc" },
  });

  // Índices rápidos código→competencia para comparar lo que ve hoy vs lo correcto.
  const porCodigo = new Map(comps.map(c => [c.codigo, c]));
  const porId     = new Map(comps.map(c => [c.id, c]));

  console.log("\n── USUARIOS ──");
  for (const u of users) {
    const compPorId     = u.competenciaId ? porId.get(u.competenciaId) : null;
    const compPorCodigo = porCodigo.get(u.competenciaCodigo);

    // RAPs que VE HOY el endpoint (filtra por competenciaId).
    const veHoy = compPorId ? compPorId._count.raps : 0;
    // RAPs que DEBERÍA ver si se resolviera por código (el identificador estable).
    const deberiaVer = compPorCodigo ? compPorCodigo._count.raps : 0;

    let veredicto;
    if (!u.competenciaId)                veredicto = "🔴 competenciaId=NULL → /api/raps responde 422";
    else if (!compPorId)                 veredicto = "🔴 competenciaId OBSOLETO (no existe esa Competencia) → 200 []";
    else if (veHoy === 0 && deberiaVer)  veredicto = "🟠 su competencia no tiene RAPs por id pero SÍ por código → re-vincular";
    else if (veHoy === 0)                veredicto = "🟠 su competencia existe pero tiene 0 RAPs → cargar RAPs";
    else                                 veredicto = `✅ ve ${veHoy} RAPs`;

    console.log(`\n  ${u.email}  (${u.rol})`);
    console.log(`    competenciaCodigo : ${u.competenciaCodigo || "(vacío)"}  ${compPorCodigo ? `→ existe, raps=${deberiaVer}` : "→ NO existe esa competencia en DB"}`);
    console.log(`    competenciaId     : ${u.competenciaId || "(null)"}  ${compPorId ? `→ existe, raps=${veHoy}` : (u.competenciaId ? "→ ⚠ no resuelve (cuid obsoleto)" : "")}`);
    console.log(`    competenciaNombre : ${u.competenciaNombre || "(vacío)"}`);
    console.log(`    veredicto         : ${veredicto}`);
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exitCode = 1; })
      .finally(() => prisma.$disconnect());
