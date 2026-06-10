/**
 * mensajesMasivos.js — lógica compartida del envío masivo de mensajes.
 *
 * La usan DOS callers (por eso vive aquí y no en la ruta — regla §5.1, la
 * lógica de negocio compartida no se duplica):
 *   - api/src/routes/mensajes.js        → POST /api/mensajes/enviar-masivo
 *   - api/src/workers/mensajesProgramadosWorker.js → corridas recurrentes
 *
 * Conceptos:
 *   - "pendiente"   = entrega en estado sin_entregar.
 *   - "desaprobada" = entrega calificada que no aprueba (regla SENA universal:
 *                     nota <70/100 o cualitativa D). Las sin_entregar NO cuentan
 *                     aquí — son otra categoría en filtros y en {{evidencias}}.
 *   - Alcance de evidencias para {{evidencias}} (multi-instructor por ficha):
 *       evidenciaIds  → SOLO esas (selección del front / programado "ids")
 *       competenciaCodigo → las activas cuyo nombre contiene el código
 *       ninguno       → todas las activas de la ficha (líder de ficha)
 *     Siempre restringido al fichaId (ya verificado del usuario) → sin fugas
 *     multi-tenant, y siempre excluyendo cerradas (cerradaAt != null).
 */

const prisma = require("../db/client");
const { mensajesQueue, emailMasivoQueue } = require("./queue");

/** Ver cabecera: calificada que no aprueba (<70 o cualitativa D). */
function esEntregaDesaprobada(e) {
  if (e.estado === "sin_entregar") return false;
  if (/^d/i.test(String(e.notaCualitativa ?? "").trim())) return true;
  return e.notaActual != null && Number(e.notaActual) < 70;
}

/**
 * Calcula, por aprendiz, los nombres de evidencias pendientes y desaprobadas
 * dentro del alcance dado (ver cabecera del archivo).
 *
 * @returns {Promise<Map<string, { pendientes: string[], desaprobadas: string[] }>>}
 */
async function resumenEvidenciasPorAprendiz({ fichaId, aprendizIds, evidenciaIds, competenciaCodigo }) {
  const whereEvidencia = { fichaId, cerradaAt: null };
  if (Array.isArray(evidenciaIds) && evidenciaIds.length > 0) {
    whereEvidencia.id = { in: evidenciaIds.map(String) };
  } else {
    whereEvidencia.activaParaScan = true;
    if (competenciaCodigo) whereEvidencia.nombre = { contains: competenciaCodigo };
  }

  const entregas = await prisma.entrega.findMany({
    where: {
      aprendizId: { in: aprendizIds },
      evidencia:  whereEvidencia,
    },
    select: {
      aprendizId: true, estado: true, notaActual: true, notaCualitativa: true,
      evidencia: { select: { nombre: true } },
    },
    orderBy: { evidencia: { nombre: "asc" } },
  });

  const resumen = new Map();
  for (const e of entregas) {
    if (!resumen.has(e.aprendizId)) resumen.set(e.aprendizId, { pendientes: [], desaprobadas: [] });
    if (e.estado === "sin_entregar")    resumen.get(e.aprendizId).pendientes.push(e.evidencia.nombre);
    else if (esEntregaDesaprobada(e))   resumen.get(e.aprendizId).desaprobadas.push(e.evidencia.nombre);
  }
  return resumen;
}

/**
 * Aplana el resumen de UN aprendiz al array de strings que consumen los workers
 * de envío ({{evidencias}}): pendientes tal cual, desaprobadas etiquetadas —
 * paridad con la Extensión Z, que reporta ambas listas.
 */
function aplanarEvidenciasToken(item, incluirDesaprobadas) {
  if (!item) return [];
  const out = [...item.pendientes];
  if (incluirDesaprobadas) {
    out.push(...item.desaprobadas.map(n => `${n} (desaprobada — corregir y reenviar)`));
  }
  return out;
}

/**
 * Crea el MensajeFormativo (queda en historial) y encola el job de envío en la
 * cola del canal. `destinatarios` ya viene enriquecido (nombre/email/moodleId/
 * evidencias/ficha/instructor). Devuelve { mensaje, jobId }.
 */
async function crearYEncolarEnvio({ userId, fichaId, canal, asunto, cuerpo, destinatarios, templateTipo = null, actaId = null }) {
  const mensaje = await prisma.mensajeFormativo.create({
    data: {
      userId, fichaId, canal, asunto, cuerpo,
      actaId:        actaId || null,
      destinatarios,
      templateTipo:  templateTipo || null,
      estado:        "pendiente",
    },
  });

  let jobId = null;
  if (canal === "email") {
    const job = await emailMasivoQueue.add("enviar", {
      mensajeFormativoId: mensaje.id,
      userId,
    });
    jobId = job.id;
  } else {
    // canal=zajuna → worker de mensajería interna Moodle (necesita credenciales)
    const user = await prisma.user.findUnique({
      where:  { id: userId },
      select: { zajunaUserEnc: true, zajunaPassEnc: true },
    });
    const job = await mensajesQueue.add("enviar", {
      mensajeId:     mensaje.id,
      userId,
      destinatarios,
      cuerpo,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });
    jobId = job.id;
  }

  return { mensaje, jobId };
}

module.exports = { esEntregaDesaprobada, resumenEvidenciasPorAprendiz, aplanarEvidenciasToken, crearYEncolarEnvio };
