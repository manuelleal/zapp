/**
 * foroDescubrirWorker.js
 *
 * Worker complementario a foroRatingWorker. Mientras foroRating APLICA
 * calificaciones (input: ratings → output: results), este worker DESCUBRE
 * quién publicó en el foro pero aún no tiene rating asignado por el
 * instructor.
 *
 * Job data:
 *   { jobId, userId, evidenciaId, actId, zajunaUserEnc, zajunaPassEnc }
 *
 * Resultado guardado en Job.resultado:
 *   {
 *     pendientes:  [{ moodleUserId, nombreAutor, postsTotales, postsSinCalificar, ratingOptions, aprendizId?, nombreLocal? }],
 *     calificados: [{ moodleUserId, nombreAutor, ratingActual, postsTotales, aprendizId?, nombreLocal? }],
 *     totalUsers, totalPosts, totalDiscussionsRevisadas,
 *   }
 *
 * Cruza moodleUserId con la tabla Aprendiz de la ficha asociada a la
 * evidencia, así la UI puede mostrar nombre canónico + permitir abrir el
 * detalle del aprendiz sin tener que volver a scrapear.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { log } = require("../../../scraper/auth");
const { descubrirCalificacionesPendientesForo } = require("../../../scraper/foroRating");

const worker = new Worker("foroDescubrir", async (job) => {
  const { jobId, userId, evidenciaId, actId, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  // Sesión + candado por-usuario vía factory (ver api/src/lib/playwrightSession.js).
  const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 30_000 } });
  const { page } = sesion;

  try {
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 25 } });

    // Scraping
    const descubrimiento = await descubrirCalificacionesPendientesForo(page, actId);

    await prisma.job.update({ where: { id: jobId }, data: { progreso: 75 } });

    // Cruzar moodleUserId con tabla Aprendiz (de la ficha de la evidencia)
    let ev = null;
    if (evidenciaId) {
      ev = await prisma.evidencia.findUnique({
        where:  { id: evidenciaId },
        select: { fichaId: true },
      });
    }

    let aprendizPorMoodle = new Map();
    if (ev) {
      const moodleIds = [
        ...descubrimiento.pendientes.map(p => p.moodleUserId),
        ...descubrimiento.calificados.map(c => c.moodleUserId),
      ];
      const aprendices = await prisma.aprendiz.findMany({
        where:  { fichaId: ev.fichaId, moodleId: { in: moodleIds } },
        select: { id: true, nombre: true, moodleId: true },
      });
      aprendizPorMoodle = new Map(aprendices.map(a => [a.moodleId, a]));
    }

    const enriquecer = (lista) => lista.map(item => {
      const a = aprendizPorMoodle.get(item.moodleUserId);
      return {
        ...item,
        aprendizId:  a ? a.id     : null,
        nombreLocal: a ? a.nombre : null,
      };
    });

    const resultado = {
      pendientes:                enriquecer(descubrimiento.pendientes),
      calificados:               enriquecer(descubrimiento.calificados),
      totalUsers:                descubrimiento.totalUsers,
      totalPosts:                descubrimiento.totalPosts,
      totalDiscussionsRevisadas: descubrimiento.totalDiscussionsRevisadas,
      evidenciaId,
      actId,
    };

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado },
    });

    log(`[foroDescubrirWorker] ✓ ${resultado.pendientes.length} pendientes / ${resultado.calificados.length} calificados`);

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
