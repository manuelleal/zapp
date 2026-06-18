/**
 * foroRatingWorker.js — Cola "foroRating".
 *
 * QUÉ HACE: aplica calificaciones (ratings) a los posts de un foro evaluable en
 * Moodle. Recibe una lista de ratings por aprendiz y los postea uno a uno.
 *
 * job.data: { jobId, userId, evidenciaId, actId, ratings, zajunaUserEnc, zajunaPassEnc }
 *
 * ⚠️ IDEMPOTENCIA: si la cola reintenta tras un post sin respuesta de Moodle,
 *   podría re-calificar. Riesgo conocido (CLAUDE.md P1 #10). concurrency: 2.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { calificarPostsForo } = require("../../../scraper/foroRating");

const worker = new Worker("foroRating", async (job) => {
  const { jobId, userId, evidenciaId, actId, ratings, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 30_000 } });
  const { page } = sesion;

  try {
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

    const results = await calificarPostsForo(page, actId, ratings);

    // Si hubo cambios exitosos, invalidar la cache de entregas actualizando los estados:
    // marcamos cada entrega correspondiente como "calificado" para reflejar en la UI sin re-scrapeo.
    const okIds = results.filter((r) => r.ok).map((r) => String(r.moodleUserId));
    if (okIds.length > 0) {
      // Buscar aprendices por moodleId y actualizar el estado de su entrega en esta evidencia
      const ev = await prisma.evidencia.findUnique({ where: { id: evidenciaId }, select: { fichaId: true } });
      if (ev) {
        const aprendices = await prisma.aprendiz.findMany({
          where: { fichaId: ev.fichaId, moodleId: { in: okIds } },
          select: { id: true, moodleId: true },
        });
        for (const a of aprendices) {
          await prisma.entrega.updateMany({
            where: { evidenciaId, aprendizId: a.id },
            data:  { estado: "calificado", fechaScan: new Date() },
          });
        }
      }
    }

    await prisma.job.update({
      where: { id: jobId },
      data:  {
        status: "done",
        progreso: 100,
        resultado: {
          total: results.length,
          ok:    results.filter((r) => r.ok).length,
          results,
        },
      },
    });

  } finally {
    await sesion.release();
  }

}, { connection, concurrency: 2 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
