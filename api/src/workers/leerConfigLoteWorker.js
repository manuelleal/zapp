require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { log } = require("../../../scraper/auth");
const { enableEditMode } = require("../../../scraper/configEvidencias");
const { cookieHeaderFromState, leerConfigEvidenciaFetch } = require("../../../scraper/configEvidenciasFetch");

// Lector en LOTE (B1): Playwright se usa SOLO para login + activar modo edición
// (una vez). El recorrido pesado de las N evidencias se hace por `fetch` de Node
// con las cookies de la sesión (sin Chromium) → ~0 RAM de browser en el loop y
// alta concurrencia. Validado con paridad 8/8 vs la lectura Playwright (jun 2026).
//
// Si una evidencia falla, se registra y se continúa con las demás (no aborta el
// lote). Cachea cada una en EvidenciaConfig + Evidencia.configCache.
const worker = new Worker("leerConfigLote", async (job) => {
  const { jobId, userId, courseId, evidencias, zajunaUserEnc, zajunaPassEnc } = job.data;

  await prisma.job.update({ where: { id: jobId }, data: { status: "running", progreso: 2 } });

  const total = Array.isArray(evidencias) ? evidencias.length : 0;
  if (total === 0) {
    await prisma.job.update({
      where: { id: jobId },
      data:  { status: "done", progreso: 100, resultado: { leidas: 0, fallidas: 0, detalle: [] } },
    });
    return;
  }

  const detalle = [];
  let leidas = 0;
  let fallidas = 0;

  // ── FASE 1: Playwright SOLO para login + modo edición + extraer cookies ─────
  // La factory adquiere el CANDADO por-usuario (que se mantiene durante TODO el
  // job, incluido el loop de fetch — si otro job logueara, invalidaría la sesión
  // y los fetch rebotarían). Tras activar edit=on y sacar las cookies, liberamos
  // SOLO el browser (releaseBrowser) para no gastar RAM en el loop; el candado
  // sigue tomado hasta release() en el finally.
  const sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 30_000 } });
  let cookieStr;
  try {
    // Modo edición una vez (preferencia de sesión → la heredan los fetch).
    if (courseId) await enableEditMode(sesion.page, courseId);
    cookieStr = cookieHeaderFromState(await sesion.ctx.storageState());
    await sesion.releaseBrowser(); // libera Chromium ANTES del loop; mantiene el candado

    await prisma.job.update({ where: { id: jobId }, data: { progreso: 8 } });

  // ── FASE 2: recorrer evidencias por FETCH (sin Chromium), en paralelo ───────
  // Concurrencia alta: cada fetch pesa KB, no MB. Cursor compartido entre carriles.
  const CONCURRENCY = Math.min(Number(process.env.LEER_CONFIG_CONCURRENCY) || 8, total);
  let cursor = 0;
  let hechas = 0;

  async function procesarUno(idx) {
    const { evidenciaId, actId } = evidencias[idx];
    try {
      const configActual = await leerConfigEvidenciaFetch(cookieStr, actId);

      await prisma.evidencia.update({
        where: { id: evidenciaId },
        data:  { configCache: configActual, configCacheAt: new Date() },
      });
      await prisma.evidenciaConfig.create({
        data: { evidenciaId, raw: configActual.raw ?? {} },
      }).catch((e) => log(`[leerConfigLote] no se pudo guardar historial ${evidenciaId}: ${e.message}`));

      leidas++;
      detalle.push({ evidenciaId, ok: true });
    } catch (err) {
      fallidas++;
      detalle.push({ evidenciaId, ok: false, error: err.message });
      log(`[leerConfigLote] fallo en evidencia ${evidenciaId} (actId=${actId}): ${err.message}`);
    }

    hechas++;
    const progreso = Math.min(98, 8 + Math.round((hechas / total) * 90));
    await prisma.job.update({ where: { id: jobId }, data: { progreso } }).catch(() => {});
  }

  async function carril() {
    for (;;) {
      const idx = cursor++;
      if (idx >= total) return;
      await procesarUno(idx);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => carril()));

  await prisma.job.update({
    where: { id: jobId },
    data:  { status: "done", progreso: 100, resultado: { leidas, fallidas, detalle } },
  });
  } finally {
    await sesion.release(); // libera el candado por-usuario (el browser ya se liberó tras FASE 1)
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
