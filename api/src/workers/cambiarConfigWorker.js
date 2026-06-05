require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker, UnrecoverableError } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { enableEditMode } = require("../../../scraper/configEvidencias");
const { cookieHeaderFromState, leerConfigEvidenciaFetch, guardarConfigEvidenciaFetch } = require("../../../scraper/configEvidenciasFetch");

// Worker genérico para cambio masivo de configuración de evidencias.
// Acepta cualquier combinación de: abrirFecha/Hora, entregaFecha/Hora, limiteFecha/Hora, intentos.
// Playwright SOLO para login + modo edición; leer/guardar van por fetch+cheerio.
// Concurrency 1: Zajuna invalida sesiones paralelas del mismo usuario.
const worker = new Worker("cambiarConfig", async (job) => {
  const {
    configChangeJobId,
    jobId,
    userId,
    evidenciaIds,
    cambios,         // { abrirFecha?, abrirHora?, entregaFecha?, entregaHora?, limiteFecha?, limiteHora?, intentos? }
    zajunaUserEnc,
    zajunaPassEnc,
  } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 2 } });
  await prisma.configChangeJob.update({ where: { id: configChangeJobId }, data: { status: "running" } });

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const total   = evidenciaIds.length;
  const detalle = [];

  async function getPaginaAutenticada() {
    const savedSession = await loadSession(userId);
    const ctx = await acquireContext({
      locale: "es-CO",
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
      if (!sessionValida) log("[cambiarConfigWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      await login(page, zajunaUser, zajunaPass);
      const state = await ctx.storageState();
      await saveSession(userId, state).catch((e) => log(`[cambiarConfigWorker] no se pudo guardar sesión: ${e.message}`));
    }
    const cookieStr = cookieHeaderFromState(await ctx.storageState());
    return { ctx, page, cookieStr };
  }

  let ctx, page, cookieStr;
  try {
    ({ ctx, page, cookieStr } = await getPaginaAutenticada());
  } catch (err) {
    const msg = `Login fallido: ${err.message}`;
    await prisma.configChangeJob.update({ where: { id: configChangeJobId }, data: { status: "error", errorMsg: msg, detalle: [] } });
    await prisma.job.update({ where: { id: jobId }, data: { status: "error", errorMsg: msg } });
    throw err;
  }

  try {
    for (let i = 0; i < evidenciaIds.length; i++) {
      const evidenciaId = evidenciaIds[i];
      let resultadoEv;

      try {
        const ev = await prisma.evidencia.findUnique({
          where:   { id: evidenciaId },
          include: { ficha: { select: { userId: true, courseId: true } } },
        });

        if (!ev) { detalle.push({ evidenciaId, ok: false, error: "Evidencia no encontrada" }); continue; }
        if (ev.ficha.userId !== userId) { detalle.push({ evidenciaId, ok: false, error: "Sin acceso" }); continue; }

        const actId = (ev.href.match(/[?&]id=(\d+)/) || [])[1];
        if (!actId) { detalle.push({ evidenciaId, ok: false, error: "actId inválido en href" }); continue; }

        if (ev.ficha.courseId) await enableEditMode(page, ev.ficha.courseId);

        // Leer config actual para valorAntes
        let valorAntes = null;
        try {
          valorAntes = await leerConfigEvidenciaFetch(cookieStr, actId);
        } catch (e) {
          log(`[cambiarConfigWorker] no se pudo leer config antes para ${evidenciaId}: ${e.message}`);
        }

        // Aplicar cambios
        await guardarConfigEvidenciaFetch(cookieStr, actId, cambios);

        // Registrar audit
        await prisma.configAudit.create({
          data: { userId, evidenciaId, actId, antes: valorAntes ?? {}, despues: cambios },
        }).catch((e) => log(`[cambiarConfigWorker] audit error: ${e.message}`));

        resultadoEv = { evidenciaId, ok: true, nombre: ev.nombre };
        log(`[cambiarConfigWorker] ✓ ${ev.nombre}`);

      } catch (errEv) {
        const errMsg = errEv.message || String(errEv);
        log(`[cambiarConfigWorker] ✗ evidencia ${evidenciaId}: ${errMsg}`);
        resultadoEv = { evidenciaId, ok: false, error: errMsg };

        if (errMsg.includes("sesion fue expulsada") || errMsg.includes("Formulario modedit no encontrado")) {
          log("[cambiarConfigWorker] Sesión inválida, reconectando...");
          await releaseContext(ctx);
          try {
            await saveSession(userId, null).catch(() => {});
            ({ ctx, page, cookieStr } = await getPaginaAutenticada());
          } catch (reconnErr) {
            log(`[cambiarConfigWorker] No se pudo reconectar: ${reconnErr.message}`);
          }
        }
      }

      detalle.push(resultadoEv);

      const progreso = Math.round(((i + 1) / total) * 100);
      await prisma.configChangeJob.update({ where: { id: configChangeJobId }, data: { progreso, detalle } });
      await prisma.job.update({ where: { id: jobId }, data: { progreso } });
    }

    const exitosas   = detalle.filter((d) => d.ok).length;
    const fallidas   = detalle.filter((d) => !d.ok).length;
    const statusFinal = fallidas === total ? "error" : "done";

    await prisma.configChangeJob.update({
      where: { id: configChangeJobId },
      data:  { status: statusFinal, progreso: 100, detalle, errorMsg: fallidas > 0 ? `${fallidas} evidencia(s) fallaron` : null },
    });
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: statusFinal === "error" ? "error" : "done", progreso: 100, resultado: { exitosas, fallidas, total, detalle }, errorMsg: fallidas > 0 ? `${fallidas} de ${total} evidencias fallaron` : null },
    });

    log(`[cambiarConfigWorker] Completado: ${exitosas} exitosas, ${fallidas} fallidas de ${total}`);
  } finally {
    await releaseContext(ctx);
  }

}, { connection, concurrency: 1 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({ where: { id: job.data.jobId }, data: { status: "error", errorMsg: err.message } }).catch(() => {});
  }
  if (job?.data?.configChangeJobId) {
    await prisma.configChangeJob.update({ where: { id: job.data.configChangeJobId }, data: { status: "error", errorMsg: err.message } }).catch(() => {});
  }
});

module.exports = worker;
