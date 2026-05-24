require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection, evidenciasQueue } = require("../lib/queue");
const prisma = require("../db/client");

async function processUser(userId, full) {
  const user = await prisma.user.findUnique({
    where:  { id: userId },
    select: { id: true, zajunaUserEnc: true, zajunaPassEnc: true, competenciaCodigo: true },
  });
  if (!user) return;

  // full=true → procesa TODAS las fichas activas aunque tengan 0 evidencias en DB
  // (primer scan de fichas nuevas). full=false → solo fichas con al menos una
  // evidencia activa (scan incremental normal).
  const fichaWhere = full
    ? { userId, archivedAt: null }
    : { userId, archivedAt: null, evidencias: { some: { activaParaScan: true, cerradaAt: null } } };

  const fichas = await prisma.ficha.findMany({
    where:  fichaWhere,
    select: { id: true, courseId: true },
  });

  for (const ficha of fichas) {
    const dbJob = await prisma.job.create({
      data: { userId, tipo: "evidencias", fichaId: ficha.id, status: "queued" },
    });

    await evidenciasQueue.add("scan", {
      jobId:             dbJob.id,
      userId,
      fichaId:           ficha.id,
      courseId:          ficha.courseId,
      competenciaCodigo: user.competenciaCodigo,
      zajunaUserEnc:     user.zajunaUserEnc,
      zajunaPassEnc:     user.zajunaPassEnc,
    });
  }

  await prisma.user.update({
    where: { id: userId },
    data:  { lastAutoScanAt: new Date() },
  });

  console.log(`[autoScan] userId=${userId} full=${full} fichas=${fichas.length}`);
}

const worker = new Worker("autoScan", async (job) => {
  const { userId, full } = job.data;

  if (userId) {
    await processUser(userId, !!full);
  } else {
    // Repeatable global: procesa todos los usuarios
    const users = await prisma.user.findMany({ select: { id: true } });
    for (const u of users) {
      await processUser(u.id, false);
    }
  }
}, { connection, concurrency: 1 });

worker.on("failed", (job, err) => {
  console.error(`[autoScan] job failed: ${err.message}`);
});

module.exports = worker;
