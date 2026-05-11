require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const prisma = require("../db/client");
const { login } = require("../../../scraper/auth");
const { leerConfigEvidencia, guardarConfigEvidencia } = require("../../../scraper/configEvidencias");

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

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    await login(page, zajunaUser, zajunaPass);
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

    if (operation === "leer") {
      const configActual = await leerConfigEvidencia(page, actId);
      await prisma.job.update({
        where: { id: jobId },
        data:  { status: "done", progreso: 100, resultado: { config: configActual } },
      });

    } else if (operation === "guardar") {
      // Leer config antes (auditoría)
      const antes = await leerConfigEvidencia(page, actId);
      await prisma.job.update({ where: { id: jobId }, data: { progreso: 50 } });

      // Guardar cambios
      await guardarConfigEvidencia(page, actId, config);
      await prisma.job.update({ where: { id: jobId }, data: { progreso: 80 } });

      // Leer config después (verificación + auditoría)
      const despues = await leerConfigEvidencia(page, actId);

      // Persistir auditoría
      await prisma.configAudit.create({
        data: { userId, evidenciaId, actId: String(actId), antes, despues },
      });

      await prisma.job.update({
        where: { id: jobId },
        data:  { status: "done", progreso: 100, resultado: { antes, despues } },
      });

    } else {
      throw new Error(`Operación desconocida: ${operation}`);
    }

  } finally {
    await browser.close();
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
