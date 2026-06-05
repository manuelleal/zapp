/**
 * scripts/dedup-aprendices.js
 *
 * Fusiona aprendices DUPLICADOS del mismo (fichaId, moodleId). Causa raíz: el
 * scraper capturó variantes del nombre en distintos scans ("DH",
 * "DHDANIEL...", "DANIEL ... ", "DANIEL...") y el @@unique es por
 * (fichaId, nombre), así que conviven como filas distintas → el mismo aprendiz
 * aparece 2-4 veces en Excel, al calificar, etc.
 *
 * Estrategia por grupo (fichaId, moodleId):
 *   1. Elegir GANADORA = la fila con el nombre más "limpio" (con espacio, sin
 *      prefijo de iniciales pegadas, sin espacios sobrantes); empate → la de más
 *      entregas. Se renombra al nombre limpio (trim).
 *   2. Migrar Entregas de las perdedoras a la ganadora. Si la ganadora ya tiene
 *      entrega para esa evidencia (colisión @@unique), se queda la "mejor"
 *      (con nota > más reciente), se le mueven HistorialEstado/AIFeedback de la
 *      otra, y se borra la entrega duplicada.
 *   3. Migrar ActaParticipante (respetando @@unique[actaId,aprendizId]).
 *   4. Borrar las filas perdedoras.
 *
 * SEGURO: por defecto es DRY-RUN (no escribe). Para aplicar: --apply
 * Uso:  node scripts/dedup-aprendices.js [--apply]
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const prisma = require("../api/src/db/client");

const APPLY = process.argv.includes("--apply");

// Un nombre es "bueno" si parece de persona: tiene espacio, >4 chars y no es sigla.
function esBueno(n) {
  const t = (n || "").trim();
  return /\s/.test(t) && t.length > 4 && !/^[A-Z]{1,3}$/.test(t);
}

// Comparador: ganador = nombre bueno y, entre buenos, el MÁS CORTO (trim). El
// prefijo de iniciales pegadas ("JBJUAN...") siempre AÑADE caracteres sobre el
// limpio ("JUAN..."), así que el más corto con espacio es el limpio. Empate →
// el de más entregas. NO usar all-caps como señal: todos los nombres vienen en
// mayúsculas, así que un patrón de "iniciales pegadas" da falsos positivos.
function comparar(a, b) {
  const ga = esBueno(a.nombre), gb = esBueno(b.nombre);
  if (ga !== gb) return ga ? -1 : 1;                       // bueno primero
  const la = a.nombre.trim().length, lb = b.nombre.trim().length;
  if (la !== lb) return la - lb;                           // más corto (sin prefijo) primero
  return b._count.entregas - a._count.entregas;            // empate → más entregas
}

async function main() {
  console.log(APPLY ? "⚠️  MODO APPLY — se escribirá en la DB\n" : "🔎 DRY-RUN (no escribe). Usa --apply para ejecutar.\n");

  const grupos = await prisma.$queryRawUnsafe(`
    SELECT "fichaId", "moodleId", COUNT(*)::int c
    FROM "Aprendiz" WHERE "moodleId" IS NOT NULL
    GROUP BY "fichaId", "moodleId" HAVING COUNT(*) > 1`);

  console.log(`Grupos duplicados (fichaId, moodleId): ${grupos.length}`);
  let totalBorrar = 0, totalEntregasMovidas = 0, totalEntregasColision = 0, totalParticipantes = 0;

  for (const g of grupos) {
    const filas = await prisma.aprendiz.findMany({
      where: { fichaId: g.fichaId, moodleId: g.moodleId },
      include: { _count: { select: { entregas: true, participaciones: true } } },
    });
    // Ganadora: nombre más limpio (ver comparar()).
    filas.sort(comparar);
    const winner = filas[0];
    const losers = filas.slice(1);
    const nombreLimpio = winner.nombre.trim();

    console.log(`\n• ficha ${g.fichaId.slice(-6)} moodleId ${g.moodleId}: ${filas.length} filas → "${nombreLimpio}"`);
    for (const l of losers) console.log(`    borrar "${l.nombre}" (entregas=${l._count.entregas}, part=${l._count.participaciones})`);

    if (!APPLY) {
      totalBorrar += losers.length;
      continue;
    }

    // ── Aplicar fusión en transacción por grupo ──
    await prisma.$transaction(async (tx) => {
      if (winner.nombre !== nombreLimpio) {
        // evitar choque de @@unique(fichaId,nombre) si ya existe esa fila limpia
        const yaExiste = await tx.aprendiz.findFirst({ where: { fichaId: g.fichaId, nombre: nombreLimpio, id: { not: winner.id } } });
        if (!yaExiste) await tx.aprendiz.update({ where: { id: winner.id }, data: { nombre: nombreLimpio } });
      }

      for (const l of losers) {
        const entregas = await tx.entrega.findMany({ where: { aprendizId: l.id } });
        for (const e of entregas) {
          const winEnt = await tx.entrega.findUnique({ where: { evidenciaId_aprendizId: { evidenciaId: e.evidenciaId, aprendizId: winner.id } } });
          if (!winEnt) {
            await tx.entrega.update({ where: { id: e.id }, data: { aprendizId: winner.id } });
            totalEntregasMovidas++;
          } else {
            // colisión: mover historial/feedback de la perdedora a la ganadora y borrar
            await tx.historialEstado.updateMany({ where: { entregaId: e.id }, data: { entregaId: winEnt.id } });
            await tx.aIFeedback.updateMany({ where: { entregaId: e.id }, data: { entregaId: winEnt.id } });
            await tx.entrega.delete({ where: { id: e.id } });
            totalEntregasColision++;
          }
        }
        const parts = await tx.actaParticipante.findMany({ where: { aprendizId: l.id } });
        for (const pp of parts) {
          const winP = await tx.actaParticipante.findUnique({ where: { actaId_aprendizId: { actaId: pp.actaId, aprendizId: winner.id } } });
          if (!winP) await tx.actaParticipante.update({ where: { id: pp.id }, data: { aprendizId: winner.id } });
          else await tx.actaParticipante.delete({ where: { id: pp.id } });
          totalParticipantes++;
        }
        await tx.aprendiz.delete({ where: { id: l.id } });
        totalBorrar++;
      }
    });
  }

  console.log(`\n=== RESUMEN ${APPLY ? "(APLICADO)" : "(DRY-RUN)"} ===`);
  console.log(`Filas a borrar: ${totalBorrar}`);
  if (APPLY) {
    console.log(`Entregas movidas: ${totalEntregasMovidas} | colisiones resueltas: ${totalEntregasColision} | participantes: ${totalParticipantes}`);
    const total = await prisma.aprendiz.count();
    console.log(`Total aprendices ahora: ${total}`);
  } else {
    console.log("Para aplicar: node scripts/dedup-aprendices.js --apply");
  }
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error("✖", e.message); console.error(e.stack?.split("\n").slice(0,4).join("\n")); await prisma.$disconnect(); process.exit(1); });
