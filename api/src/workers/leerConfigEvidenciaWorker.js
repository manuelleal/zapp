require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { leerConfigEvidencia, enableEditMode } = require("../../../scraper/configEvidencias");

// Dedicated read-only config worker — saves to EvidenciaConfig table.
// Concurrency 1: Zajuna invalidates parallel sessions from the same account.
const worker = new Worker("leerConfig", async (job) => {
  const {
    jobId,
    userId,
    evidenciaId,
    actId,
    zajunaUserEnc,
    zajunaPassEnc,
  } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const savedSession = await loadSession(userId);
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
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
      if (!sessionValida) log("[leerConfigWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      try {
        await login(page, zajunaUser, zajunaPass);
      } catch (err) {
        if (err.message === "Credenciales incorrectas.") throw new UnrecoverableError(err.message);
        throw err;
      }
      const state = await ctx.storageState();
      await saveSession(userId, state).catch((e) => log(`[leerConfigWorker] no se pudo guardar sesión: ${e.message}`));
    }
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 20 } });

    const ev = await prisma.evidencia.findUnique({
      where:   { id: evidenciaId },
      include: { ficha: { select: { courseId: true } } },
    });
    const courseId = ev?.ficha?.courseId;
    if (courseId) await enableEditMode(page, courseId);

    await prisma.job.update({ where: { id: jobId }, data: { progreso: 40 } });

    const configActual = await leerConfigEvidencia(page, actId);

    // Persist to dedicated EvidenciaConfig table
    await prisma.evidenciaConfig.create({
      data: {
        evidenciaId,
        raw: configActual.raw ?? {},
      },
    });

    // Also update inline cache for backward compat with configWorker consumers
    await prisma.evidencia.update({
      where: { id: evidenciaId },
      data:  { configCache: configActual, configCacheAt: new Date() },
    }).catch((e) => log(`[leerConfigWorker] no se pudo cachear: ${e.message}`));

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { config: configActual } },
    });

  } finally {
    await browser.close();
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
