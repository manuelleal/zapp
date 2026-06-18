/**
 * foroRatingWorker.js — Cola "foroRating".
 *
 * QUÉ HACE: aplica calificaciones (ratings) a los posts de un foro evaluable en
 * Moodle. Recibe una lista de ratings por aprendiz y los postea uno a uno.
 *
 * job.data: { jobId, userId, evidenciaId, actId, ratings, zajunaUserEnc, zajunaPassEnc }
 *
 * ⚠️ IDEMPOTENCIA: si la cola reintenta tras un post sin respuesta de Moodle,
 *   podría re-calificar. Riesgo conocido (CLAUDE.md P1 #10). concurrency: 2.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { marcarCredencialesInvalidas, marcarCredencialesValidas } = require("../lib/credencialesEstado");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { calificarPostsForo } = require("../../../scraper/foroRating");

const worker = new Worker("foroRating", async (job) => {
  const { jobId, userId, evidenciaId, actId, ratings, zajunaUserEnc, zajunaPassEnc } = job.data;

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
      if (!sessionValida) log("[foroRatingWorker] Sesión expirada, login fresco");
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
      await saveSession(userId, state).catch(e => log(`[foroRatingWorker] no se pudo guardar sesión: ${e.message}`));
    }
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

    const results = await calificarPostsForo(page, actId, ratings);

    // Si hubo cambios exitosos, invalidar la cache de entregas actualizando los estados:
    // marcamos cada entrega correspondiente como "calificado" para reflejar en la UI sin re-scrapeo.
    const okIds = results.filter((r) => r.ok).map((r) => String(r.moodleUserId));
    if (okIds.length > 0) {
      // Buscar aprendices por moodleId y actualizar el estado de su entrega en esta evidencia
      const ev = await prisma.evidencia.findUnique({ where: { id: evidenciaId }, select: { fichaId: true } });
      if (ev) {
        const aprendices = await prisma.aprendiz.findMany({
          where: { fichaId: ev.fichaId, moodleId: { in: okIds } },
          select: { id: true, moodleId: true },
        });
        for (const a of aprendices) {
          await prisma.entrega.updateMany({
            where: { evidenciaId, aprendizId: a.id },
            data:  { estado: "calificado", fechaScan: new Date() },
          });
        }
      }
    }

    await prisma.job.update({
      where: { id: jobId },
      data:  {
        status: "done",
        progreso: 100,
        resultado: {
          total: results.length,
          ok:    results.filter((r) => r.ok).length,
          results,
        },
      },
    });

  } finally {
    await releaseContext(ctx);
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
