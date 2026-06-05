require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { descubrirFichas } = require("../../../scraper/fichas");

const worker = new Worker("fichas", async (job) => {
  const { jobId, userId, zajunaUserEnc, zajunaPassEnc, competenciaCodigo } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const savedSession = await loadSession(userId);
  const ctx = await acquireContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    ...(savedSession ? { storageState: savedSession } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    let sessionValida = false;
    if (savedSession) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      sessionValida = !page.url().includes("/login") && page.url().includes("zajuna.sena.edu.co");
      if (!sessionValida) log("[fichasWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      try {
        await login(page, zajunaUser, zajunaPass);
      } catch (err) {
        if (err.message === "Credenciales incorrectas.") throw new UnrecoverableError(err.message);
        throw err;
      }
      const state = await ctx.storageState();
      await saveSession(userId, state).catch(e => log(`[fichasWorker] no se pudo guardar sesión: ${e.message}`));
    }
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
    await releaseContext(ctx);
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
