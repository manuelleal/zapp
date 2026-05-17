require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { enviarMensajeMoodle } = require("../../../scraper/mensajes");

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker("mensajes", async (job) => {
  const { mensajeId, userId, destinatarios, cuerpo, zajunaUserEnc, zajunaPassEnc } = job.data;

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  // ─── Autenticación Playwright ──────────────────────────────────────────────

  async function getPaginaAutenticada() {
    const savedSession = await loadSession(userId);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      locale:     "es-CO",
      timezoneId: "America/Bogota",
      ...(savedSession ? { storageState: savedSession } : {}),
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);

    let sessionValida = false;
    if (savedSession) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      sessionValida = !page.url().includes("/login") && page.url().includes("zajuna.sena.edu.co");
      if (!sessionValida) log("[mensajeFormativoWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      await login(page, zajunaUser, zajunaPass);
      const state = await ctx.storageState();
      await saveSession(userId, state).catch(e => log(`[mensajeFormativoWorker] no se pudo guardar sesión: ${e.message}`));
    }
    return { browser, page, ctx };
  }

  // ─── Login inicial ─────────────────────────────────────────────────────────

  let browser, page;
  try {
    ({ browser, page } = await getPaginaAutenticada());
  } catch (err) {
    await prisma.mensajeFormativo.update({
      where: { id: mensajeId },
      data:  { estado: "error", errorMsg: `Login fallido: ${err.message}`, enviadoAt: new Date() },
    });
    throw err;
  }

  // ─── Envío por destinatario ────────────────────────────────────────────────

  let enviados  = 0;
  let fallidos  = 0;

  try {
    for (const dest of destinatarios) {
      if (!dest.moodleId) {
        log(`[mensajeFormativoWorker] Sin moodleId para aprendizId=${dest.aprendizId} (${dest.nombre ?? "desconocido"}) — omitiendo`);
        fallidos++;
        continue;
      }

      try {
        const resultado = await enviarMensajeMoodle(page, dest.moodleId, cuerpo);
        if (resultado.ok) {
          enviados++;
        } else {
          log(`[mensajeFormativoWorker] Error enviando a moodleId=${dest.moodleId}: ${resultado.error}`);
          fallidos++;

          if (resultado.error && (
            resultado.error.includes("sesskey") ||
            resultado.error.includes("sesion fue expulsada") ||
            resultado.error.includes("session")
          )) {
            log("[mensajeFormativoWorker] Posible sesión inválida, reconectando...");
            try { await browser.close(); } catch (_) {}
            try {
              await saveSession(userId, null).catch(() => {});
              ({ browser, page } = await getPaginaAutenticada());
            } catch (reconnErr) {
              log(`[mensajeFormativoWorker] No se pudo reconectar: ${reconnErr.message}`);
            }
          }
        }
      } catch (errDest) {
        log(`[mensajeFormativoWorker] Excepción enviando a moodleId=${dest.moodleId}: ${errDest.message}`);
        fallidos++;

        if (errDest.message.includes("sesion fue expulsada") || errDest.message.includes("session")) {
          log("[mensajeFormativoWorker] Sesión inválida detectada, reconectando...");
          try { await browser.close(); } catch (_) {}
          try {
            await saveSession(userId, null).catch(() => {});
            ({ browser, page } = await getPaginaAutenticada());
          } catch (reconnErr) {
            log(`[mensajeFormativoWorker] No se pudo reconectar: ${reconnErr.message}`);
          }
        }
      }
    }

    // ─── Actualizar estado final en DB ─────────────────────────────────────

    const total = destinatarios.length;

    if (fallidos === 0) {
      await prisma.mensajeFormativo.update({
        where: { id: mensajeId },
        data:  { estado: "enviado", enviadoAt: new Date() },
      });
    } else {
      await prisma.mensajeFormativo.update({
        where: { id: mensajeId },
        data:  {
          estado:    "error",
          errorMsg:  `${enviados}/${total} enviados`,
          enviadoAt: new Date(),
        },
      });
    }

    log(`[mensajeFormativoWorker] Completado: ${enviados} enviados, ${fallidos} fallidos de ${total}`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }

}, { connection, concurrency: 1 });

// ─── Evento failed ─────────────────────────────────────────────────────────────

worker.on("failed", async (job, err) => {
  if (job?.data?.mensajeId) {
    await prisma.mensajeFormativo.update({
      where: { id: job.data.mensajeId },
      data:  { estado: "error", errorMsg: err.message, enviadoAt: new Date() },
    }).catch(() => {});
  }
});

module.exports = worker;
