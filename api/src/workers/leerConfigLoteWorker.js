require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { leerConfigEvidencia, enableEditMode } = require("../../../scraper/configEvidencias");

// Lector en LOTE (B1): abre UNA sola sesión Playwright, hace login una vez y
// recorre TODAS las evidencias de una ficha leyendo su config (fechas/intentos)
// desde modedit.php. Cachea cada una en EvidenciaConfig + Evidencia.configCache.
//
// A diferencia de leerConfigEvidenciaWorker (1 evidencia = 1 browser + 1 login),
// aquí el costo de arranque se paga una sola vez para todo el lote. Si una
// evidencia falla, se registra y se continúa con las demás (no aborta el lote).
const worker = new Worker("leerConfigLote", async (job) => {
  const { jobId, userId, courseId, evidencias, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 2 } });

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const total = Array.isArray(evidencias) ? evidencias.length : 0;
  if (total === 0) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { leidas: 0, fallidas: 0, detalle: [] } },
    });
    return;
  }

  const savedSession = await loadSession(userId);
  const browser = await chromium.launch({ headless: true });
  let browserClosed = false;
  const closeBrowser = async () => { if (!browserClosed) { browserClosed = true; await browser.close(); } };

  const ctx = await browser.newContext({
    locale: "es-CO",
    timezoneId: "America/Bogota",
    ...(savedSession ? { storageState: savedSession } : {}),
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(30_000);

  const detalle = [];
  let leidas = 0;
  let fallidas = 0;

  try {
    // ── Login (reusa sesión guardada si sigue viva) ──────────────────────────
    let sessionValida = false;
    if (savedSession) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      sessionValida = !page.url().includes("/login") && page.url().includes("zajuna.sena.edu.co");
      if (!sessionValida) log("[leerConfigLote] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      try {
        await login(page, zajunaUser, zajunaPass);
      } catch (err) {
        if (err.message === "Credenciales incorrectas.") throw new UnrecoverableError(err.message);
        throw err;
      }
      const state = await ctx.storageState();
      await saveSession(userId, state).catch((e) => log(`[leerConfigLote] no se pudo guardar sesión: ${e.message}`));
    }

    // ── Modo edición una sola vez para toda la ficha ─────────────────────────
    if (courseId) await enableEditMode(page, courseId);
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 8 } });

    // ── Recorrer todas las evidencias ────────────────────────────────────────
    for (let i = 0; i < total; i++) {
      const { evidenciaId, actId } = evidencias[i];
      try {
        const configActual = await leerConfigEvidencia(page, actId);

        await prisma.evidenciaConfig.create({
          data: { evidenciaId, raw: configActual.raw ?? {} },
        });
        await prisma.evidencia.update({
          where: { id: evidenciaId },
          data:  { configCache: configActual, configCacheAt: new Date() },
        }).catch((e) => log(`[leerConfigLote] no se pudo cachear ${evidenciaId}: ${e.message}`));

        leidas++;
        detalle.push({ evidenciaId, ok: true });
      } catch (err) {
        fallidas++;
        detalle.push({ evidenciaId, ok: false, error: err.message });
        log(`[leerConfigLote] fallo en evidencia ${evidenciaId} (actId=${actId}): ${err.message}`);
      }

      // Progreso 8% → 98% repartido entre las evidencias.
      const progreso = Math.min(98, 8 + Math.round(((i + 1) / total) * 90));
      await prisma.job.update({ where: { id: jobId }, data: { progreso } }).catch(() => {});
    }

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { leidas, fallidas, detalle } },
    });
  } finally {
    await closeBrowser();
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
