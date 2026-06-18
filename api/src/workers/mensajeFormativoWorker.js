/**
 * mensajeFormativoWorker.js — Cola "mensajes".
 *
 * QUÉ HACE: envía mensajes internos de Moodle a los aprendices (mensajería 1:1
 * vía scraper/mensajes.enviarMensajeMoodle), personalizando el cuerpo con
 * {{nombre}}/{{ficha}}/{{instructor}}/{{evidencias}} por destinatario.
 *
 * TOKEN {{evidencias}}: se expande a la lista de evidencias pendientes/
 * desaprobadas de CADA aprendiz (dest.evidencias, poblado por la ruta
 * /api/mensajes/enviar-masivo). Formato texto plano (mismo espíritu que
 * construirMensaje() en scraper/mensajes.js — no se importa para no acoplar
 * el worker al scraper por un formateo de strings):
 *   "Tienes N evidencia(s) pendiente(s):\n  1. <nombre>\n  2. ..."
 * Si el aprendiz no tiene evidencias, el token se reemplaza por cadena vacía
 * (nunca queda el "{{evidencias}}" crudo en el mensaje enviado).
 *
 * job.data: { mensajeId, userId, destinatarios, cuerpo, zajunaUserEnc, zajunaPassEnc }
 *   Actualiza el registro MensajeFormativo (mensajeId) con el resultado.
 * concurrency: 1 (sesión Moodle única por usuario).
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { acquireContext, releaseContext } = require("../lib/browserPool");
const { connection } = require("../lib/queue");
const { decrypt } = require("../lib/crypto");
const { saveSession, loadSession } = require("../lib/sessionStore");
const prisma = require("../db/client");
const { login, cerrarModal, BASE_URL, log } = require("../../../scraper/auth");
const { enviarMensajeMoodle } = require("../../../scraper/mensajes");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Normaliza dest.evidencias a un array de nombres (strings).
 * Defensivo: acepta array de strings ("Evidencia GA1...") O de objetos
 * ({ nombre: "..." }) — el front hoy no manda evidencias (la ruta default-ea
 * a []), así que cubrimos ambos shapes para no romper cuando se cablee.
 */
function nombresDeEvidencias(evidencias) {
  if (!Array.isArray(evidencias)) return [];
  return evidencias
    .map(e => (typeof e === "string" ? e : e?.nombre ?? ""))
    .map(s => String(s).trim())
    .filter(Boolean);
}

/**
 * Texto plano para el token {{evidencias}} (ver cabecera del archivo).
 * Devuelve "" si no hay items — el token desaparece del mensaje.
 */
function formatearEvidencias(evidencias) {
  const nombres = nombresDeEvidencias(evidencias);
  if (nombres.length === 0) return "";
  return [
    `Tienes ${nombres.length} evidencia(s) pendiente(s):`,
    ...nombres.map((n, i) => `  ${i + 1}. ${n}`),
  ].join("\n");
}

function personalizarCuerpo(cuerpo, dest, ficha, instructor) {
  return String(cuerpo ?? "")
    .replace(/\{\{nombre\}\}/gi,     dest.nombre ?? "")
    .replace(/\{\{ficha\}\}/gi,      ficha)
    .replace(/\{\{instructor\}\}/gi, instructor)
    // función como replacement: evita que un "$&"/"$1" en el nombre de una
    // evidencia se interprete como patrón especial de String.replace
    .replace(/\{\{evidencias\}\}/gi, () => formatearEvidencias(dest.evidencias));
}

// ─── Worker ───────────────────────────────────────────────────────────────────

const worker = new Worker("mensajes", async (job) => {
  const { mensajeId, userId, destinatarios, cuerpo, zajunaUserEnc, zajunaPassEnc } = job.data;

  const zajunaUser = decrypt(zajunaUserEnc);
  const zajunaPass = decrypt(zajunaPassEnc);

  // ─── Autenticación Playwright ──────────────────────────────────────────────

  async function getPaginaAutenticada() {
    const savedSession = await loadSession(userId);
    const ctx = await acquireContext({
      locale:     "es-CO",
      timezoneId: "America/Bogota",
      ...(savedSession ? { storageState: savedSession } : {}),
    });
    const page = await ctx.newPage();
    page.setDefaultTimeout(45_000);

    let sessionValida = false;
    if (savedSession) {
      await page.goto(`${BASE_URL}/my/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await cerrarModal(page);
      sessionValida = page.url().includes("/my") && !page.url().includes("/login"); // sesión SSO expirada rebota al portal raíz (sin /my), NO a /login
      if (!sessionValida) log("[mensajeFormativoWorker] Sesión expirada, login fresco");
    }
    if (!sessionValida) {
      await login(page, zajunaUser, zajunaPass);
      const state = await ctx.storageState();
      await saveSession(userId, state).catch(e => log(`[mensajeFormativoWorker] no se pudo guardar sesión: ${e.message}`));
    }
    return { ctx, page };
  }

  // ─── Login inicial ─────────────────────────────────────────────────────────

  let ctx, page;
  try {
    ({ ctx, page } = await getPaginaAutenticada());
  } catch (err) {
    await prisma.mensajeFormativo.update({
      where: { id: mensajeId },
      data:  { estado: "error", errorMsg: `Login fallido: ${err.message}`, enviadoAt: new Date() },
    });
    throw err;
  }

  // ─── Cargar ficha e instructor ────────────────────────────────────────────

  const mf = await prisma.mensajeFormativo.findUnique({
    where: { id: mensajeId },
    include: {
      ficha: { select: { codigo: true } },
      user:  { select: { nombre: true } },
    },
  });
  const fichaCode        = mf?.ficha?.codigo ?? "";
  const instructorNombre = mf?.user?.nombre  ?? "";

  // ─── Envío por destinatario ────────────────────────────────────────────────

  let enviados  = 0;
  let fallidos  = 0;

  try {
    for (const dest of destinatarios) {
      if (!dest.moodleId) {
        log(`[mensajeFormativoWorker] Sin moodleId para aprendizId=${dest.aprendizId} (${dest.nombre ?? "desconocido"}) — omitiendo`);
        fallidos++;
        continue;
      }

      try {
        const cuerpoPersonalizado = personalizarCuerpo(cuerpo, dest, fichaCode, instructorNombre);
        const resultado = await enviarMensajeMoodle(page, dest.moodleId, cuerpoPersonalizado);
        if (resultado.ok) {
          enviados++;
        } else {
          log(`[mensajeFormativoWorker] Error enviando a moodleId=${dest.moodleId}: ${resultado.error}`);
          fallidos++;

          if (resultado.error && (
            resultado.error.includes("sesskey") ||
            resultado.error.includes("sesion fue expulsada") ||
            resultado.error.includes("session")
          )) {
            log("[mensajeFormativoWorker] Posible sesión inválida, reconectando...");
            await releaseContext(ctx);
            try {
              await saveSession(userId, null).catch(() => {});
              ({ ctx, page } = await getPaginaAutenticada());
            } catch (reconnErr) {
              log(`[mensajeFormativoWorker] No se pudo reconectar: ${reconnErr.message}`);
            }
          }
        }
      } catch (errDest) {
        log(`[mensajeFormativoWorker] Excepción enviando a moodleId=${dest.moodleId}: ${errDest.message}`);
        fallidos++;

        if (errDest.message.includes("sesion fue expulsada") || errDest.message.includes("session")) {
          log("[mensajeFormativoWorker] Sesión inválida detectada, reconectando...");
          await releaseContext(ctx);
          try {
            await saveSession(userId, null).catch(() => {});
            ({ ctx, page } = await getPaginaAutenticada());
          } catch (reconnErr) {
            log(`[mensajeFormativoWorker] No se pudo reconectar: ${reconnErr.message}`);
          }
        }
      }
    }

    // ─── Actualizar estado final en DB ─────────────────────────────────────

    const total = destinatarios.length;

    if (fallidos === 0) {
      await prisma.mensajeFormativo.update({
        where: { id: mensajeId },
        data:  { estado: "enviado", enviadoAt: new Date() },
      });
    } else {
      await prisma.mensajeFormativo.update({
        where: { id: mensajeId },
        data:  {
          estado:    "error",
          errorMsg:  `${enviados}/${total} enviados`,
          enviadoAt: new Date(),
        },
      });
    }

    log(`[mensajeFormativoWorker] Completado: ${enviados} enviados, ${fallidos} fallidos de ${total}`);
  } finally {
    await releaseContext(ctx);
  }

}, { connection, concurrency: 1 });

// ─── Evento failed ─────────────────────────────────────────────────────────────

worker.on("failed", async (job, err) => {
  if (job?.data?.mensajeId) {
    await prisma.mensajeFormativo.update({
      where: { id: job.data.mensajeId },
      data:  { estado: "error", errorMsg: err.message, enviadoAt: new Date() },
    }).catch(() => {});
  }
});

module.exports = worker;
