/**
 * fichasWorker.js — Cola "fichas".
 *
 * QUÉ HACE: descubre las fichas (grupos de aprendices) que el instructor tiene en
 * Zajuna y las upsertea en la tabla `Ficha`. Es normalmente lo PRIMERO que corre
 * para un usuario: sin fichas no hay evidencias que escanear.
 *
 * job.data: { jobId, userId, zajunaUserEnc, zajunaPassEnc, competenciaCodigo }
 *   competenciaCodigo opcional → filtra el descubrimiento a una competencia.
 *
 * FLUJO (patrón estándar de los workers Playwright, ver DEVELOPER_ONBOARDING.md):
 *   1. Reusar sesión Moodle de Redis (sessionStore); si expiró, login fresco.
 *   2. scraper/fichas.descubrirFichas(page, competenciaCodigo) raspa el listado.
 *   3. upsert por (userId, codigo) — idempotente, no duplica.
 *   4. Actualiza Job.status/progreso en cada hito (5→30→70→100).
 *
 * Credenciales incorrectas → UnrecoverableError (no reintenta). concurrency: 5.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { descubrirFichas } = require("../../../scraper/fichas");

const worker = new Worker("fichas", async (job) => {
  const { jobId, userId, zajunaUserEnc, zajunaPassEnc, competenciaCodigo } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 5 } });

  const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 30_000 } });
  const { page } = sesion;

  try {
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
    await sesion.release();
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
