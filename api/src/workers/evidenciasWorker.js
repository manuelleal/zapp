require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, TIMEOUT } = require("../../../scraper/auth");
const { obtenerEvidencias, revisarEntregas } = require("../../../scraper/evidencias");

const worker = new Worker("evidencias", async (job) => {
  const { jobId, userId, fichaId, courseId, competenciaCodigo, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const browser = await chromium.launch({ headless: true });
  const ctx  = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    await login(page, zajunaUser, zajunaPass);
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 30 } });

    await page.goto(`${BASE_URL}/course/view.php?id=${courseId}`, { waitUntil: "load", timeout: TIMEOUT });
    await cerrarModal(page);

    const evidencias = await obtenerEvidencias(page, competenciaCodigo);
    await prisma.job.update({ where: { id: jobId }, data: { progreso: 50 } });

    const resumen = [];

    for (let i = 0; i < evidencias.length; i++) {
      const ev = evidencias[i];
      const entregas = await revisarEntregas(page, ev.actId);

      // Upsert evidencia (preserva cerradaAt actual)
      const evDb = await prisma.evidencia.upsert({
        where:  { fichaId_href: { fichaId, href: ev.href } },
        update: { nombre: ev.texto },
        create: { fichaId, nombre: ev.texto, href: ev.href, tipo: "assign" },
      });

      let pendientes  = 0;
      let calificados = 0;
      let sinEntregar = 0;

      for (const entrega of entregas) {
        // Upsert aprendiz
        const aprendizDb = await prisma.aprendiz.upsert({
          where:  { fichaId_nombre: { fichaId, nombre: entrega.nombre } },
          update: {},
          create: { fichaId, nombre: entrega.nombre },
        });

        // Upsert entrega con historial si el estado cambió
        const entregaExistente = await prisma.entrega.findUnique({
          where: { evidenciaId_aprendizId: { evidenciaId: evDb.id, aprendizId: aprendizDb.id } },
        });

        if (!entregaExistente) {
          await prisma.entrega.create({
            data: { evidenciaId: evDb.id, aprendizId: aprendizDb.id, estado: entrega.estado },
          });
        } else if (entregaExistente.estado !== entrega.estado) {
          await prisma.historialEstado.create({
            data: {
              entregaId:     entregaExistente.id,
              estadoAnterior: entregaExistente.estado,
              estadoNuevo:    entrega.estado,
            },
          });
          await prisma.entrega.update({
            where: { id: entregaExistente.id },
            data:  { estado: entrega.estado, fechaScan: new Date() },
          });
        }

        if (entrega.estado === "pendiente")    pendientes++;
        else if (entrega.estado === "calificado")  calificados++;
        else if (entrega.estado === "sin_entregar") sinEntregar++;
      }

      // Cierre/reapertura es 100% manual desde la UI: no tocamos cerradaAt aqui.
      // Razon: pendientes=0 puede deberse a evidencias con fechas viejas, no a
      // que esten realmente revisadas. El instructor decide.

      resumen.push({
        nombre:     ev.texto,
        href:       ev.href,
        pendientes,
        calificados,
        sinEntregar,
        total:      entregas.length,
      });

      const progreso = Math.round(50 + ((i + 1) / evidencias.length) * 40);
      await prisma.job.update({ where: { id: jobId }, data: { progreso } });
    }

    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { fichaId, evidencias: resumen } },
    });

  } finally {
    await browser.close();
  }

}, { connection, concurrency: 3 });

worker.on("failed", async (job, err) => {
  if (job?.data?.jobId) {
    await prisma.job.update({
      where: { id: job.data.jobId },
      data:  { status: "error", errorMsg: err.message },
    }).catch(() => {});
  }
});

module.exports = worker;
