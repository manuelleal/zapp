require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { enableEditMode } = require("../../../scraper/configEvidencias");
const { cookieHeaderFromState, leerConfigEvidenciaFetch, guardarConfigEvidenciaFetch } = require("../../../scraper/configEvidenciasFetch");

// Cola "config": lee o guarda la config (fechas/intentos) de UNA evidencia.
// Playwright se usa SOLO para login + activar modo edición; la lectura y el
// guardado van por fetch+cheerio (configEvidenciasFetch). operation = leer|guardar.
const worker = new Worker("config", async (job) => {
  const {
    jobId,
    userId,
    evidenciaId,
    actId,
    operation,   // "leer" | "guardar"
    config,      // solo para "guardar"
    zajunaUserEnc,
    zajunaPassEnc,
  } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  // Sesión autenticada vía factory: compone loadSession/login/saveSession y
  // adquiere el candado por-usuario (Zajuna = 1 sesión/cuenta). release() en el
  // finally libera context Y candado. Ver api/src/lib/playwrightSession.js.
  const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 30_000 } });
  const { page, ctx } = sesion;

  try {
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 20 } });

    // Sprint 2.6 fix: Moodle requiere modo edición ON para que /course/modedit.php
    // renderice el formulario. La sesion Playwright es fresca → toggle explicito.
    const ev = await prisma.evidencia.findUnique({
      where: { id: evidenciaId },
      include: { ficha: { select: { courseId: true } } },
    });
    const courseId = ev?.ficha?.courseId;
    if (courseId) {
      await enableEditMode(page, courseId);
    }
    // Cookies de la sesión ya autenticada → de aquí en más, todo por fetch.
    const cookieStr = cookieHeaderFromState(await ctx.storageState());
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

    if (operation === "leer") {
      const configActual = await leerConfigEvidenciaFetch(cookieStr, actId);
      // Persistir cache (Sprint 2.5 FIX 2)
      await prisma.evidencia.update({
        where: { id: evidenciaId },
        data:  { configCache: configActual, configCacheAt: new Date() },
      }).catch((e) => console.error(`[configWorker] no se pudo cachear leer: ${e.message}`));

      await prisma.job.update({
        where: { id: jobId },
        data:  { status: "done", progreso: 100, resultado: { config: configActual } },
      });

    } else if (operation === "guardar") {
      // Leer config antes (auditoría)
      const antes = await leerConfigEvidenciaFetch(cookieStr, actId);
      await prisma.job.update({ where: { id: jobId }, data: { progreso: 50 } });

      // Guardar cambios (guardarConfigEvidenciaFetch verifica el guardado internamente)
      await guardarConfigEvidenciaFetch(cookieStr, actId, config);
      await prisma.job.update({ where: { id: jobId }, data: { progreso: 80 } });

      // Leer config después (verificación + auditoría)
      const despues = await leerConfigEvidenciaFetch(cookieStr, actId);

      // Persistir auditoría
      await prisma.configAudit.create({
        data: { userId, evidenciaId, actId: String(actId), antes, despues },
      });

      // Actualizar cache con el estado post-guardado (Sprint 2.5 FIX 2)
      await prisma.evidencia.update({
        where: { id: evidenciaId },
        data:  { configCache: despues, configCacheAt: new Date() },
      }).catch((e) => console.error(`[configWorker] no se pudo cachear guardar: ${e.message}`));

      await prisma.job.update({
        where: { id: jobId },
        data:  { status: "done", progreso: 100, resultado: { antes, despues } },
      });

    } else {
      throw new Error(`Operación desconocida: ${operation}`);
    }

  } finally {
    await sesion.release();
  }

// Sprint 2.6 FIX D: concurrency=1 — Zajuna invalida sesiones paralelas
// del mismo usuario. Si dos jobs corren a la vez, el segundo login expulsa
// al primero y su navegacion a /course/modedit.php redirige al login.
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
