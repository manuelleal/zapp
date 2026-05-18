require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { chromium } = require("playwright");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const prisma = require("../db/client");
const { login, log } = require("../../../scraper/auth");
const { sincronizarParticipantes } = require("../../../scraper/mensajes");

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

  const browser = await chromium.launch({ headless: true });
  const ctx     = await browser.newContext({ locale: "es-CO", timezoneId: "America/Bogota" });
  const page    = await ctx.newPage();
  page.setDefaultTimeout(45_000);

  try {
    await login(page, zajunaUser, zajunaPass);
    const participantes = await sincronizarParticipantes(page, courseId);

    let actualizados   = 0;
    let creadosEmails  = 0;
    let sinMatch       = 0;

    for (const p of participantes) {
      if (!p.email || !p.moodleId) continue;

      // Parseo permisivo de "Último acceso" (Moodle suele devolver formato es-CO o "Nunca")
      let ultimoAcceso = undefined;
      if (p.ultimoAcceso && !/nunca/i.test(p.ultimoAcceso)) {
        const ts = Date.parse(p.ultimoAcceso);
        if (!Number.isNaN(ts)) ultimoAcceso = new Date(ts);
      }

      const updateData = { email: p.email };
      if (ultimoAcceso) updateData.ultimoAcceso = ultimoAcceso;

      const r = await prisma.aprendiz.updateMany({
        where: { fichaId, moodleId: String(p.moodleId) },
        data:  updateData,
      });

      if (r.count > 0) {
        actualizados++;
        if (p.email) creadosEmails++;
      } else {
        sinMatch++;
        log(`[syncParticipantesWorker] sin match en DB para moodleId=${p.moodleId} (${p.nombre})`);
      }
    }

    log(`[syncParticipantesWorker] fichaId=${fichaId} — actualizados=${actualizados}, sinMatch=${sinMatch}, total=${participantes.length}`);
    return { actualizados, creadosEmails, sinMatch, total: participantes.length };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}, { connection, concurrency: 1 });

worker.on("failed", (job, err) => {
  console.error(`[syncParticipantesWorker] job ${job?.id} failed:`, err.message);
});

module.exports = worker;
