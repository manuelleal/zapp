/**
 * envioReanudable.js — Lógica pura para reanudar envíos masivos sin duplicar.
 *
 * PROBLEMA QUE RESUELVE:
 * La cola "mensajes" tiene `attempts: 2`. Si el proceso de workers muere a mitad
 * del loop de envío (OOM, taskkill, redeploy), BullMQ marca el job como stalled y
 * lo reintenta desde cero. Sin esta lib, los aprendices que ya recibieron el mensaje
 * lo recibirían de nuevo.
 *
 * SOLUCIÓN:
 * El worker llama a `job.updateProgress({ enviadosMoodleIds: [...] })` tras cada
 * envío exitoso. BullMQ persiste `job.progress` en Redis; al reintentar, la nueva
 * ejecución rehidrata `job.progress` desde Redis y llama a `destinatariosPendientes`
 * para filtrar los que ya recibieron el mensaje.
 *
 * ESTA LIB ES PURA: no importa queue, bullmq, prisma ni nada que conecte a Redis o DB.
 * Eso permite testearla con node:test sin infraestructura.
 */

"use strict";

/**
 * Filtra los destinatarios que faltan por enviar dado el progreso persistido del
 * job en intentos anteriores (retry).
 *
 * @param {Array<{ moodleId?: number|string|null }>} destinatarios
 *   Lista completa de destinatarios del job (job.data.destinatarios).
 * @param {(number|string)[]} enviadosMoodleIds
 *   Lista de moodleIds ya enviados en attempts anteriores
 *   (extraída de job.progress.enviadosMoodleIds).
 * @returns {Array} — Subconjunto de destinatarios pendientes.
 *
 * Reglas:
 * - Destinatario cuyo moodleId (normalizado a String) esté en enviadosMoodleIds → excluido.
 * - Destinatario SIN moodleId → SIEMPRE incluido (el loop del worker ya maneja
 *   ese caso: lo cuenta como fallido y continúa; no tiene sentido saltearlo aquí
 *   porque nunca fue enviado).
 * - Normalización a String para que `1041858` y `"1041858"` sean el mismo id.
 */
function destinatariosPendientes(destinatarios, enviadosMoodleIds) {
  if (!Array.isArray(destinatarios)) return [];

  // Construir Set de ids ya enviados (todos como strings para comparación uniforme)
  const yaEnviados = new Set(
    Array.isArray(enviadosMoodleIds)
      ? enviadosMoodleIds.map(String)
      : []
  );

  if (yaEnviados.size === 0) {
    // Primer attempt o progreso vacío → devolver todos sin filtrar (camino rápido)
    return destinatarios;
  }

  return destinatarios.filter(dest => {
    if (dest.moodleId == null) {
      // Sin moodleId: nunca fue enviado, debe intentarse (fallará en el loop
      // del worker con fallidos++ pero no es responsabilidad de este filtro)
      return true;
    }
    // Excluir si ya se envió en un attempt anterior
    return !yaEnviados.has(String(dest.moodleId));
  });
}

module.exports = { destinatariosPendientes };
