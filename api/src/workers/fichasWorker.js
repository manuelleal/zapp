require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const prisma = require("../db/client");
const { login } = require("../../../scraper/auth");
const { descubrirFichas } = require("../../../scraper/fichas");

const worker = new Worker("fichas", async (job) => {
  const { jobId, userId, zajunaUserEnc, zajunaPassEnc, competenciaCodigo } = job.data;

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

    const { fichas } = await descubrirFichas(page, competenciaCodigo);
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 70 } });

    for (const f of fichas) {
      await prisma.ficha.upsert({
        where:  { userId_codigo: { userId, codigo: f.codigo } },
        update: { programa: f.programa, courseId: f.courseId, nombre: f.nombre },
        create: { userId, codigo: f.codigo, programa: f.programa, courseId: f.courseId, nombre: f.nombre },
      });
    }

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { fichas } },
    });

  } finally {
    await browser.close();
  }

}, { connection, concurrency: 5 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
