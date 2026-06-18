require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { log } = require("../../../scraper/auth");
const { leerConfigEvidencia, enableEditMode } = require("../../../scraper/configEvidencias");

// Lector de config de UNA evidencia (cola "leerConfig"). Guarda en EvidenciaConfig.
// NOTA: el camino moderno/liviano es leerConfigLoteWorker.js (fetch+cheerio); este
// sigue en Playwright. La sesión + candado por-usuario los da la factory
// crearSesionAutenticada; si el form no carga (sesión expirada), se hace UN
// relogin() y se reintenta una vez. Concurrency 1.
const worker = new Worker("leerConfig", async (job) => {
  const { jobId, userId, evidenciaId, actId, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 30_000 } });

  // Activa modo edición (Moodle lo exige para renderizar modedit) y lee la config.
  async function leer() {
    const ev = await prisma.evidencia.findUnique({
      where:   { id: evidenciaId },
      include: { ficha: { select: { courseId: true } } },
    });
    if (ev?.ficha?.courseId) await enableEditMode(sesion.page, ev.ficha.courseId);
    return leerConfigEvidencia(sesion.page, actId);
  }

  try {
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 20 } });

    let configActual;
    try {
      configActual = await leer();
    } catch (firstErr) {
      // Form no encontrado / sesión expulsada → relogin (mismo context y candado)
      // y un único reintento.
      if (
        firstErr.message.includes("Formulario modedit no encontrado") ||
        firstErr.message.includes("sesion fue expulsada")
      ) {
        log(`[leerConfigWorker] Primer intento falló (${firstErr.message}). Re-login y reintento.`);
        await sesion.relogin();
        await prisma.job.update({ where: { id: jobId }, data: { progreso: 50 } });
        configActual = await leer();
      } else {
        throw firstErr;
      }
    }

    // Persistir en EvidenciaConfig + cache inline (compat con consumidores).
    await prisma.evidenciaConfig.create({ data: { evidenciaId, raw: configActual.raw ?? {} } });
    await prisma.evidencia.update({
      where: { id: evidenciaId },
      data:  { configCache: configActual, configCacheAt: new Date() },
    }).catch((e) => log(`[leerConfigWorker] no se pudo cachear: ${e.message}`));

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { config: configActual } },
    });
  } finally {
    await sesion.release();
  }

}, { connection, concurrency: 1 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
