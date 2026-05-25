/**
 * foroDescubrirWorker.js
 *
 * Worker complementario a foroRatingWorker. Mientras foroRating APLICA
 * calificaciones (input: ratings → output: results), este worker DESCUBRE
 * quién publicó en el foro pero aún no tiene rating asignado por el
 * instructor.
 *
 * Job data:
 *   { jobId, userId, evidenciaId, actId, zajunaUserEnc, zajunaPassEnc }
 *
 * Resultado guardado en Job.resultado:
 *   {
 *     pendientes:  [{ moodleUserId, nombreAutor, postsTotales, postsSinCalificar, ratingOptions, aprendizId?, nombreLocal? }],
 *     calificados: [{ moodleUserId, nombreAutor, ratingActual, postsTotales, aprendizId?, nombreLocal? }],
 *     totalUsers, totalPosts, totalDiscussionsRevisadas,
 *   }
 *
 * Cruza moodleUserId con la tabla Aprendiz de la ficha asociada a la
 * evidencia, así la UI puede mostrar nombre canónico + permitir abrir el
 * detalle del aprendiz sin tener que volver a scrapear.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { descubrirCalificacionesPendientesForo } = require("../../../scraper/foroRating");

const worker = new Worker("foroDescubrir", async (job) => {
  const { jobId, userId, evidenciaId, actId, zajunaUserEnc, zajunaPassEnc } = job.data;

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
      if (!sessionValida) log("[foroDescubrirWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      try {
        await login(page, zajunaUser, zajunaPass);
      } catch (err) {
        if (err.message === "Credenciales incorrectas.") throw new UnrecoverableError(err.message);
        throw err;
      }
      const state = await ctx.storageState();
      await saveSession(userId, state).catch(e => log(`[foroDescubrirWorker] no se pudo guardar sesión: ${e.message}`));
    }

    await prisma.job.update({ where: { id: jobId }, data: { progreso: 25 } });

    // Scraping
    const descubrimiento = await descubrirCalificacionesPendientesForo(page, actId);

    await prisma.job.update({ where: { id: jobId }, data: { progreso: 75 } });

    // Cruzar moodleUserId con tabla Aprendiz (de la ficha de la evidencia)
    let ev = null;
    if (evidenciaId) {
      ev = await prisma.evidencia.findUnique({
        where:  { id: evidenciaId },
        select: { fichaId: true },
      });
    }

    let aprendizPorMoodle = new Map();
    if (ev) {
      const moodleIds = [
        ...descubrimiento.pendientes.map(p => p.moodleUserId),
        ...descubrimiento.calificados.map(c => c.moodleUserId),
      ];
      const aprendices = await prisma.aprendiz.findMany({
        where:  { fichaId: ev.fichaId, moodleId: { in: moodleIds } },
        select: { id: true, nombre: true, moodleId: true },
      });
      aprendizPorMoodle = new Map(aprendices.map(a => [a.moodleId, a]));
    }

    const enriquecer = (lista) => lista.map(item => {
      const a = aprendizPorMoodle.get(item.moodleUserId);
      return {
        ...item,
        aprendizId:  a ? a.id     : null,
        nombreLocal: a ? a.nombre : null,
      };
    });

    const resultado = {
      pendientes:                enriquecer(descubrimiento.pendientes),
      calificados:               enriquecer(descubrimiento.calificados),
      totalUsers:                descubrimiento.totalUsers,
      totalPosts:                descubrimiento.totalPosts,
      totalDiscussionsRevisadas: descubrimiento.totalDiscussionsRevisadas,
      evidenciaId,
      actId,
    };

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado },
    });

    log(`[foroDescubrirWorker] ✓ ${resultado.pendientes.length} pendientes / ${resultado.calificados.length} calificados`);

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
