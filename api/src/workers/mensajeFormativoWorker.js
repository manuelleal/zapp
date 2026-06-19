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
 *
 * IDEMPOTENCIA EN RETRY (anti-doble-envío):
 * La cola tiene `attempts: 2`. Si el proceso muere a mitad del loop (OOM,
 * taskkill, redeploy), BullMQ marca el job como stalled y lo reintenta.
 * Para evitar que los aprendices ya contactados reciban el mensaje dos veces:
 *   - Tras cada envío exitoso se persiste `job.progress.enviadosMoodleIds` en Redis
 *     vía `job.updateProgress(...)`. BullMQ conserva este progreso entre attempts.
 *   - Al inicio del handler se lee ese progreso y se filtran los ya enviados con
 *     `destinatariosPendientes()` (ver api/src/lib/envioReanudable.js).
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../../.env") });

const { Worker } = require("bullmq");
const { connection } = require("../lib/queue");
const { crearSesionAutenticada } = require("../lib/playwrightSession");
const prisma = require("../db/client");
const { log } = require("../../../scraper/auth");
const { enviarMensajeMoodle } = require("../../../scraper/mensajes");
const { destinatariosPendientes } = require("../lib/envioReanudable");

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
 * Devuelve SOLO la lista numerada (sin frase introductoria, para no duplicar el
 * "tienes N pendientes" que ya trae la plantilla). "" si no hay items.
 */
function formatearEvidencias(evidencias) {
  const nombres = nombresDeEvidencias(evidencias);
  if (nombres.length === 0) return "";
  return nombres.map((n, i) => `  ${i + 1}. ${n}`).join("\n");
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

  // ─── Sesión + candado por-usuario vía factory ──────────────────────────────
  let sesion, page;
  try {
    sesion = await crearSesionAutenticada({ userId, zajunaUserEnc, zajunaPassEnc, opts: { timeout: 45_000 } });
    page = sesion.page;
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

  // Idempotencia en retry: recuperar los moodleIds ya enviados en attempts
  // anteriores. En el primer attempt job.progress === 0 (número) → Set vacío.
  const yaEnviados = new Set(
    Array.isArray(job.progress?.enviadosMoodleIds)
      ? job.progress.enviadosMoodleIds.map(String)
      : []
  );
  if (yaEnviados.size > 0) {
    log(`[mensajeFormativoWorker] retry: ${yaEnviados.size} destinatario(s) ya enviados en attempt anterior — se omiten`);
  }

  // Filtrar los que faltan usando la lib pura (excluye los ya enviados;
  // los sin moodleId siempre pasan para que el loop los cuente como fallidos)
  const pendientes = destinatariosPendientes(destinatarios, [...yaEnviados]);

  // El contador `enviados` arranca con los que ya completamos en attempts previos
  // para que el mensaje final "X/total enviados" sea veraz.
  let enviados  = yaEnviados.size;
  let fallidos  = 0;

  try {
    for (const dest of pendientes) {
      if (!dest.moodleId) {
        log(`[mensajeFormativoWorker] Sin moodleId para aprendizId=${dest.aprendizId} (${dest.nombre ?? "desconocido"}) — omitiendo`);
        fallidos++;
        continue;
      }

      try {
        const cuerpoPersonalizado = personalizarCuerpo(cuerpo, dest, fichaCode, instructorNombre);
        const resultado = await enviarMensajeMoodle(page, dest.moodleId, cuerpoPersonalizado);
        if (resultado.ok) {
          // Registrar envío exitoso antes de continuar con el siguiente:
          // si el proceso muere aquí, el retry saltará este destinatario.
          yaEnviados.add(String(dest.moodleId));
          await job.updateProgress({ enviadosMoodleIds: [...yaEnviados] });
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
            try {
              await sesion.relogin();   // re-login en el mismo context, conserva el candado
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
          try {
            await sesion.relogin();
          } catch (reconnErr) {
            log(`[mensajeFormativoWorker] No se pudo reconectar: ${reconnErr.message}`);
          }
        }
      }
    }

    // ─── Actualizar estado final en DB ─────────────────────────────────────

    const total = destinatarios.length;

    // Estado final con tres niveles (antes "error" en cuanto fallaba 1 de N, lo que
    // hacía ver un envío de 49/50 como fallo total):
    //   - todos OK            → "enviado"
    //   - ninguno se envió    → "error"
    //   - algunos sí, otros no → "parcial" (la mayoría se entregó; revisar los fallidos)
    let estado, errorMsg = null;
    if (fallidos === 0)        { estado = "enviado"; }
    else if (enviados === 0)   { estado = "error";   errorMsg = `No se pudo enviar a ningún destinatario (0/${total}).`; }
    else                       { estado = "parcial"; errorMsg = `${enviados}/${total} enviados, ${fallidos} fallidos (sin usuario de Moodle o sesión interrumpida).`; }

    await prisma.mensajeFormativo.update({
      where: { id: mensajeId },
      data:  { estado, errorMsg, enviadoAt: new Date() },
    });

    log(`[mensajeFormativoWorker] Completado: ${enviados} enviados, ${fallidos} fallidos de ${total}`);
  } finally {
    await sesion.release();
  }

}, { connection, concurrency: 1 });

// ─── Evento failed ─────────────────────────────────────────────────────────────
//
// Este evento se dispara por CADA attempt fallido de BullMQ, incluidos los
// intermedios (attempt 1 falla → marca estado "error"; attempt 2 completa →
// el handler actualiza estado "enviado"/"error" con el resultado real).
// El update del attempt 2 ocurre DESPUÉS del evento "failed" del attempt 1,
// así que el estado final en DB es siempre el del último attempt que terminó.
// No hay riesgo de sobreescritura: el attempt 2 tiene la última palabra.

worker.on("failed", async (job, err) => {
  if (job?.data?.mensajeId) {
    await prisma.mensajeFormativo.update({
      where: { id: job.data.mensajeId },
      data:  { estado: "error", errorMsg: err.message, enviadoAt: new Date() },
    }).catch(() => {});
  }
});

module.exports = worker;
