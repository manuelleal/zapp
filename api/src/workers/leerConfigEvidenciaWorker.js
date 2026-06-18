require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { marcarCredencialesInvalidas, marcarCredencialesValidas } = require("../lib/credencialesEstado");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { leerConfigEvidencia, enableEditMode } = require("../../../scraper/configEvidencias");

// Dedicated read-only config worker — saves to EvidenciaConfig table.
// NOTA: Este worker sigue en Playwright (no migrado). El camino moderno/liviano
// es leerConfigLoteWorker.js usando fetch+cheerio.
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
  const ctx = await acquireContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    ...(savedSession ? { storageState: savedSession } : {}),
  });
  let ctxReleased = false;
  // Cierra el primer context de forma idempotente. En el path de reintento por
  // sesión expirada se libera este context y se adquiere uno nuevo (ctx2).
  async function releaseFirst() {
    if (!ctxReleased) { ctxReleased = true; await releaseContext(ctx); }
  }
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  try {
    let sessionValida = false;
    if (savedSession) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      sessionValida = page.url().includes("/my") && !page.url().includes("/login"); // sesión SSO expirada rebota al portal raíz (sin /my), NO a /login
      if (!sessionValida) log("[leerConfigWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      try {
        await login(page, zajunaUser, zajunaPass);
        await marcarCredencialesValidas(userId);
      } catch (err) {
        if (err.message === "Credenciales incorrectas.") {
          await marcarCredencialesInvalidas(userId);
          throw new UnrecoverableError(err.message);
        }
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

    let configActual;
    try {
      configActual = await leerConfigEvidencia(page, actId);
    } catch (firstErr) {
      // Si el formulario no se encontró, puede ser sesión expirada.
      // Borrar sesión guardada y reintentar con login fresco (1 solo retry).
      if (
        firstErr.message.includes("Formulario modedit no encontrado") ||
        firstErr.message.includes("sesion fue expulsada")
      ) {
        log(`[leerConfigWorker] Primer intento falló (${firstErr.message}). Borrando sesión y reintentando con login fresco.`);
        await saveSession(userId, null).catch(() => {});
        await releaseFirst();

        const ctx2     = await acquireContext({ locale: "es-CO", timezoneId: "America/Bogota" });
        const page2    = await ctx2.newPage();
        page2.setDefaultTimeout(30_000);
        try {
          await login(page2, zajunaUser, zajunaPass);
          const state2 = await ctx2.storageState();
          await saveSession(userId, state2).catch((e) => log(`[leerConfigWorker] no se pudo guardar sesión: ${e.message}`));
          await prisma.job.update({ where: { id: jobId }, data: { progreso: 50 } });

          const ev2       = await prisma.evidencia.findUnique({
            where:   { id: evidenciaId },
            include: { ficha: { select: { courseId: true } } },
          });
          const courseId2 = ev2?.ficha?.courseId;
          if (courseId2) await enableEditMode(page2, courseId2);

          await prisma.job.update({ where: { id: jobId }, data: { progreso: 65 } });
          configActual = await leerConfigEvidencia(page2, actId);
        } finally {
          await releaseContext(ctx2);
        }
        // Persist and return early from the retry path
        await prisma.evidenciaConfig.create({ data: { evidenciaId, raw: configActual.raw ?? {} } });
        await prisma.evidencia.update({
          where: { id: evidenciaId },
          data:  { configCache: configActual, configCacheAt: new Date() },
        }).catch((e) => log(`[leerConfigWorker] no se pudo cachear: ${e.message}`));
        await prisma.job.update({
          where: { id: jobId },
          data:  { status: "done", progreso: 100, resultado: { config: configActual } },
        });
        return;
      }
      throw firstErr;
    }

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
    await releaseFirst();
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
