require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const prisma = require("../db/client");
const { login, log } = require("../../../scraper/auth");
const { obtenerMatriculados } = require("../../../scraper/evidencias");

// ─── Worker ───────────────────────────────────────────────────────────────────
// Sincroniza emails y último acceso de los aprendices de una ficha desde Moodle.
// Stateless: abre browser → login → scrape → updateMany → cierra browser.

const worker = new Worker("syncParticipantes", async (job) => {
  const { fichaId, courseId, zajunaUserEnc, zajunaPassEnc } = job.data;

  if (!fichaId || !courseId || !zajunaUserEnc || !zajunaPassEnc) {
    throw new Error("Faltan parámetros: fichaId, courseId, zajunaUserEnc, zajunaPassEnc.");
  }

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  const ctx     = await acquireContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(45_000);

  try {
    await login(page, zajunaUser, zajunaPass);
    const participantes = await obtenerMatriculados(page, courseId);

    let actualizados   = 0;
    let creadosEmails  = 0;
    let sinMatch       = 0;

    for (const p of participantes) {
      if (!p.moodleUserId) continue;

      const updateData = { moodleId: String(p.moodleUserId) };
      if (p.email)     updateData.email     = p.email;
      if (p.documento) updateData.documento = p.documento;

      // Primary: match by moodleId (fast path — already synced before)
      let r = await prisma.aprendiz.updateMany({
        where: { fichaId, moodleId: String(p.moodleUserId) },
        data:  updateData,
      });

      // Fallback: match by nombre when moodleId still null in DB
      // (happens when evidencias scan ran before the grade-report fix)
      if (r.count === 0 && p.nombre) {
        r = await prisma.aprendiz.updateMany({
          where: { fichaId, moodleId: null, nombre: p.nombre },
          data:  updateData,
        });
      }

      if (r.count > 0) {
        actualizados++;
        if (p.email) creadosEmails++;
      } else {
        sinMatch++;
        log(`[syncParticipantesWorker] sin match en DB para moodleId=${p.moodleUserId} (${p.nombre})`);
      }
    }

    log(`[syncParticipantesWorker] fichaId=${fichaId} — actualizados=${actualizados}, sinMatch=${sinMatch}, total=${participantes.length}`);
    return { actualizados, creadosEmails, sinMatch, total: participantes.length };
  } finally {
    await releaseContext(ctx);
  }
}, { connection, concurrency: 1 });

worker.on("failed", (job, err) => {
  console.error(`[syncParticipantesWorker] job ${job?.id} failed:`, err.message);
});

module.exports = worker;
