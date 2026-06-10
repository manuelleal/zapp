/**
 * scripts/fix-nombres-aprendices.js
 *
 * Limpieza one-off de nombres de Aprendiz dañados por scans viejos (pre 9-jun):
 *
 *   1. ESPACIOS — nombres con espacios sobrantes (trailing o dobles, p.ej.
 *      "JUAN  PEREZ "). El worker viejo guardaba el texto sin trim; el actual
 *      ya limpia al crear, pero nunca corrige filas existentes → quedaron 145.
 *   2. PLACEHOLDERS — nombres "Aprendiz {moodleId}" creados cuando el scan no
 *      trajo fullname. El nombre real se rescata de OTRA fila Aprendiz con el
 *      mismo moodleId (la copia de la misma ficha de otro tenant, o cualquier
 *      otra ficha donde sí quedó bien).
 *
 * Si el nombre destino YA existe en la misma ficha (@@unique[fichaId,nombre])
 * se FUSIONA: sobreviven la fila con nombre limpio, se le migran Entregas
 * (resolviendo colisiones de @@unique[evidenciaId,aprendizId] como en
 * dedup-aprendices.js) y ActaParticipante, y se borra la fila sucia.
 *
 * SEGURO: por defecto es DRY-RUN (no escribe). Para aplicar: --apply
 * Uso:  node scripts/fix-nombres-aprendices.js [--apply]
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const APPLY = process.argv.includes("--apply");

const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
const esPlaceholder = (s) => /^Aprendiz \d+$/.test(norm(s));

/**
 * Fusiona `loser` dentro de `winner` (misma ficha, mismo aprendiz real):
 * migra Entregas (con resolución de colisión por evidencia) y ActaParticipante,
 * copia moodleId/documento/email si al winner le faltan, y borra al loser.
 */
async function fusionar(tx, winner, loser, stats) {
  const entregas = await tx.entrega.findMany({ where: { aprendizId: loser.id } });
  for (const e of entregas) {
    const winEnt = await tx.entrega.findUnique({
      where: { evidenciaId_aprendizId: { evidenciaId: e.evidenciaId, aprendizId: winner.id } },
    });
    if (!winEnt) {
      await tx.entrega.update({ where: { id: e.id }, data: { aprendizId: winner.id } });
      stats.entregasMovidas++;
    } else {
      // colisión: conservar la del winner, traspasar historial/feedback y borrar
      await tx.historialEstado.updateMany({ where: { entregaId: e.id }, data: { entregaId: winEnt.id } });
      await tx.aIFeedback.updateMany({ where: { entregaId: e.id }, data: { entregaId: winEnt.id } });
      await tx.entrega.delete({ where: { id: e.id } });
      stats.entregasColision++;
    }
  }
  const parts = await tx.actaParticipante.findMany({ where: { aprendizId: loser.id } });
  for (const pp of parts) {
    const winP = await tx.actaParticipante.findUnique({
      where: { actaId_aprendizId: { actaId: pp.actaId, aprendizId: winner.id } },
    });
    if (!winP) await tx.actaParticipante.update({ where: { id: pp.id }, data: { aprendizId: winner.id } });
    else await tx.actaParticipante.delete({ where: { id: pp.id } });
  }
  // El loser puede tener datos que al winner le faltan (moodleId del scan viejo).
  const relleno = {};
  if (!winner.moodleId && loser.moodleId)   relleno.moodleId  = loser.moodleId;
  if (!winner.documento && loser.documento) relleno.documento = loser.documento;
  if (!winner.email && loser.email)         relleno.email     = loser.email;
  if (Object.keys(relleno).length) await tx.aprendiz.update({ where: { id: winner.id }, data: relleno });

  await tx.aprendiz.delete({ where: { id: loser.id } });
  stats.fusionados++;
}

/** Renombra `fila` a `nombreNuevo`; si choca con otra fila de la ficha, fusiona. */
async function renombrarOFusionar(fila, nombreNuevo, stats, motivo) {
  const ocupante = await prisma.aprendiz.findUnique({
    where: { fichaId_nombre: { fichaId: fila.fichaId, nombre: nombreNuevo } },
  });
  if (ocupante && ocupante.id !== fila.id) {
    console.log(`  [${motivo}] "${fila.nombre}" → FUSIONAR con "${nombreNuevo}" (ya existe en la ficha)`);
    if (!APPLY) { stats.fusionados++; return; }
    await prisma.$transaction((tx) => fusionar(tx, ocupante, fila, stats));
  } else {
    console.log(`  [${motivo}] "${fila.nombre}" → "${nombreNuevo}"`);
    if (!APPLY) { stats.renombrados++; return; }
    await prisma.aprendiz.update({ where: { id: fila.id }, data: { nombre: nombreNuevo } });
    stats.renombrados++;
  }
}

async function main() {
  console.log(APPLY ? "⚠️  MODO APPLY — se escribirá en la DB\n" : "🔎 DRY-RUN (no escribe). Usa --apply para ejecutar.\n");
  const stats = { renombrados: 0, fusionados: 0, entregasMovidas: 0, entregasColision: 0, sinGemelo: 0 };

  // ── 1. Placeholders "Aprendiz {id}" → nombre real desde otra fila con el mismo moodleId ──
  const placeholders = await prisma.aprendiz.findMany({
    where: { nombre: { startsWith: "Aprendiz " } },
    include: { ficha: { select: { codigo: true } } },
  });
  console.log(`Placeholders "Aprendiz {id}": ${placeholders.filter(a => esPlaceholder(a.nombre)).length}`);
  for (const a of placeholders) {
    if (!esPlaceholder(a.nombre)) continue; // por si algún aprendiz se llama así de verdad
    if (!a.moodleId) { console.log(`  [placeholder] "${a.nombre}" sin moodleId — no se puede rescatar`); stats.sinGemelo++; continue; }
    // Gemelo: preferir una fila de una ficha con el MISMO código (mismo curso real).
    const gemelos = await prisma.aprendiz.findMany({
      where: { moodleId: a.moodleId, id: { not: a.id }, NOT: { nombre: { startsWith: "Aprendiz " } } },
      include: { ficha: { select: { codigo: true } } },
    });
    const gemelo = gemelos.find(g => g.ficha.codigo === a.ficha.codigo) || gemelos[0];
    if (!gemelo) { console.log(`  [placeholder] "${a.nombre}" sin gemelo con nombre real — quedará para el próximo scan`); stats.sinGemelo++; continue; }
    await renombrarOFusionar(a, norm(gemelo.nombre), stats, "placeholder");
  }

  // ── 2. Espacios sobrantes (trailing / dobles) ──
  const todos = await prisma.aprendiz.findMany({ select: { id: true, fichaId: true, nombre: true, moodleId: true, documento: true, email: true } });
  const sucios = todos.filter(a => a.nombre !== norm(a.nombre) && !esPlaceholder(a.nombre));
  console.log(`\nNombres con espacios sobrantes: ${sucios.length}`);
  for (const a of sucios) {
    await renombrarOFusionar(a, norm(a.nombre), stats, "espacios");
  }

  console.log(`\n=== RESUMEN ${APPLY ? "(APLICADO)" : "(DRY-RUN)"} ===`);
  console.log(`Renombrados: ${stats.renombrados} | Fusionados: ${stats.fusionados} | Sin gemelo: ${stats.sinGemelo}`);
  if (APPLY) console.log(`Entregas movidas: ${stats.entregasMovidas} | colisiones resueltas: ${stats.entregasColision}`);
  else console.log("Para aplicar: node scripts/fix-nombres-aprendices.js --apply");
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("✖", e.message); console.error(e.stack?.split("\n").slice(0, 6).join("\n")); await prisma.$disconnect(); process.exit(1); });
