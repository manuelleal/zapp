require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { log } = require("../../../scraper/auth");
const { enableEditMode } = require("../../../scraper/configEvidencias");
const { cookieHeaderFromState, leerConfigEvidenciaFetch, guardarConfigEvidenciaFetch } = require("../../../scraper/configEvidenciasFetch");

// Worker para cambio masivo de fecha de cierre (duedate) y apertura.
// Playwright SOLO para login + modo edición; leer/guardar van por fetch+cheerio.
// Concurrency 1: Zajuna invalida sesiones paralelas del mismo usuario.
const worker = new Worker("cambiarFecha", async (job) => {
  const {
    configChangeJobId,
    jobId,
    userId,
    evidenciaIds,
    // Fecha de cierre/entrega (assign.duedate, forum.cutoffdate, quiz.timeclose)
    nuevaFecha,         // "YYYY-MM-DD"
    nuevaHora,          // "HH:MM"
    // Fecha de apertura — OPCIONAL (assign.allowsubmissionsfromdate,
    // forum.duedate, quiz.timeopen). Si ausente, no se modifica.
    aperturaFecha,      // "YYYY-MM-DD" | undefined
    aperturaHora,       // "HH:MM"      | undefined
    zajunaUserEnc,
    zajunaPassEnc,
  } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 2 } });
  await prisma.configChangeJob.update({ where: { id: configChangeJobId }, data: { status: "running" } });

  const total    = evidenciaIds.length;
  const detalle  = [];

  // Sesión + candado por-usuario vía factory. cookieStr se recalcula tras cada
  // (re)login; el grueso del trabajo va por fetch con esa cookie.
  let sesion, cookieStr;
  try {
    sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 45_000 } });
    cookieStr = cookieHeaderFromState(await sesion.ctx.storageState());
  } catch (err) {
    const msg = `Login fallido: ${err.message}`;
    log(`[cambiarFechaWorker] ${msg}`);
    await prisma.configChangeJob.update({
      where: { id: configChangeJobId },
      data:  { status: "error", errorMsg: msg, detalle: [] },
    });
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "error", errorMsg: msg },
    });
    throw err;
  }
  const page = sesion.page;

  try {
    for (let i = 0; i < evidenciaIds.length; i++) {
      const evidenciaId = evidenciaIds[i];
      let resultadoEv;

      try {
        // Cargar datos de la evidencia
        const ev = await prisma.evidencia.findUnique({
          where:   { id: evidenciaId },
          include: { ficha: { select: { userId: true, courseId: true } } },
        });

        if (!ev) {
          detalle.push({ evidenciaId, ok: false, error: "Evidencia no encontrada" });
          continue;
        }
        if (ev.ficha.userId !== userId) {
          detalle.push({ evidenciaId, ok: false, error: "Sin acceso" });
          continue;
        }

        const actId = (ev.href.match(/[?&]id=(\d+)/) || [])[1];
        if (!actId) {
          detalle.push({ evidenciaId, ok: false, error: "actId inválido en href" });
          continue;
        }

        const courseId = ev.ficha.courseId;
        if (courseId) {
          await enableEditMode(page, courseId);
        }

        // Leer config actual (para auditar el "antes" tanto de entrega como de apertura)
        let antesEntrega  = null;
        let antesApertura = null;
        try {
          const configActual = await leerConfigEvidenciaFetch(cookieStr, actId);
          antesEntrega = configActual.entregaFecha
            ? `${configActual.entregaFecha}T${configActual.entregaHora || "23:55"}`
            : null;
          antesApertura = configActual.abrirFecha
            ? `${configActual.abrirFecha}T${configActual.abrirHora || "00:00"}`
            : null;
        } catch (e) {
          log(`[cambiarFechaWorker] No se pudo leer config antes para ${evidenciaId}: ${e.message}`);
        }

        // Construir payload: solo enviar las fechas que el cliente pidió cambiar.
        // guardarConfigEvidencia hace un merge parcial sobre el formulario completo
        // y respeta los FIELD_MAPS por tipo (assign / forum / quiz).
        const configUpdate = {};
        if (nuevaFecha !== undefined) {
          configUpdate.entregaFecha = nuevaFecha;
          configUpdate.entregaHora  = nuevaHora;
        }
        if (aperturaFecha !== undefined) {
          configUpdate.abrirFecha = aperturaFecha;
          configUpdate.abrirHora  = aperturaHora;
        }
        await guardarConfigEvidenciaFetch(cookieStr, actId, configUpdate);

        const despuesEntrega  = nuevaFecha    !== undefined ? `${nuevaFecha}T${nuevaHora}`         : null;
        const despuesApertura = aperturaFecha !== undefined ? `${aperturaFecha}T${aperturaHora}`   : null;

        // Registrar en ConfigAudit (incluye antes/después de ambas fechas si aplican)
        await prisma.configAudit.create({
          data: {
            userId,
            evidenciaId,
            actId,
            antes:   { entregaFecha: antesEntrega,  abrirFecha: antesApertura  },
            despues: { entregaFecha: despuesEntrega, abrirFecha: despuesApertura },
          },
        }).catch((e) => log(`[cambiarFechaWorker] no se pudo crear audit: ${e.message}`));

        resultadoEv = {
          evidenciaId, ok: true, nombre: ev.nombre,
          valorAntes:   antesEntrega,   valorDespues:   despuesEntrega,
          aperturaAntes: antesApertura, aperturaDespues: despuesApertura,
        };
        const resumen = [
          despuesApertura && `apertura→${despuesApertura}`,
          despuesEntrega  && `entrega→${despuesEntrega}`,
        ].filter(Boolean).join(" / ");
        log(`[cambiarFechaWorker] ✓ ${ev.nombre} ${resumen}`);

      } catch (errEv) {
        // Fallo en una evidencia: loguear y continuar con la siguiente
        const errMsg = errEv.message || String(errEv);
        log(`[cambiarFechaWorker] ✗ evidencia ${evidenciaId}: ${errMsg}`);
        resultadoEv = { evidenciaId, ok: false, error: errMsg };

        // Si la sesión fue expulsada, reconectar para el próximo
        if (errMsg.includes("sesion fue expulsada") || errMsg.includes("Formulario modedit no encontrado")) {
          log("[cambiarFechaWorker] Sesión inválida, reconectando...");
          try {
            await sesion.relogin();   // re-login en el mismo context, conserva el candado
            cookieStr = cookieHeaderFromState(await sesion.ctx.storageState());
          } catch (reconnErr) {
            log(`[cambiarFechaWorker] No se pudo reconectar: ${reconnErr.message}`);
          }
        }
      }

      detalle.push(resultadoEv);

      // Actualizar progreso
      const procesadas = i + 1;
      const progreso   = Math.round((procesadas / total) * 100);
      await prisma.configChangeJob.update({
        where: { id: configChangeJobId },
        data:  { progreso, detalle },
      });
      await prisma.job.update({
        where: { id: jobId },
        data:  { progreso },
      });
    }

    // Resultado final
    const exitosas = detalle.filter((d) => d.ok).length;
    const fallidas = detalle.filter((d) => !d.ok).length;
    const statusFinal = fallidas === total ? "error" : exitosas === total ? "done" : "done_with_errors";

    await prisma.configChangeJob.update({
      where: { id: configChangeJobId },
      data:  {
        status:   statusFinal,
        progreso: 100,
        detalle,
        errorMsg: fallidas > 0 ? `${fallidas} evidencia(s) fallaron` : null,
      },
    });

    await prisma.job.update({
      where: { id: jobId },
      data:  {
        status:    statusFinal === "error" ? "error" : "done",
        progreso:  100,
        resultado: { exitosas, fallidas, total, detalle },
        errorMsg:  fallidas > 0 ? `${fallidas} de ${total} evidencias fallaron` : null,
      },
    });

    log(`[cambiarFechaWorker] Completado: ${exitosas} exitosas, ${fallidas} fallidas de ${total}`);

  } finally {
    await sesion.release();
  }

}, { connection, concurrency: 1 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
  if (job?.data?.configChangeJobId) {
    await prisma.configChangeJob.update({
      where: { id: job.data.configChangeJobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
