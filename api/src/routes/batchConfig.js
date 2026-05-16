const prisma = require("../db/client");
const { cambiarFechaQueue } = require("../lib/queue");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function actIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

/**
 * Parsea un datetime-local o ISO 8601 string y devuelve { fecha, hora }.
 * Acepta: "2026-06-15T23:59", "2026-06-15T23:59:00", "2026-06-15T23:59:00.000Z"
 * Devuelve: { fecha: "2026-06-15", hora: "23:55" } (hora redondeada a múltiplo de 5)
 */
function parsearDatetime(str) {
  if (!str || typeof str !== "string") return null;
  // Intentar parsear como datetime-local o ISO
  const dt = new Date(str.includes("T") ? str : str + "T00:00");
  if (isNaN(dt.getTime())) return null;

  // Extraer partes en UTC si hay zona, o local si no hay zona (datetime-local no tiene Z)
  const usarLocal = !str.endsWith("Z") && !str.match(/[+-]\d{2}:\d{2}$/);
  const year      = usarLocal ? dt.getFullYear()  : dt.getUTCFullYear();
  const month     = usarLocal ? dt.getMonth() + 1 : dt.getUTCMonth() + 1;
  const day       = usarLocal ? dt.getDate()       : dt.getUTCDate();
  const hour      = usarLocal ? dt.getHours()      : dt.getUTCHours();
  const minute    = usarLocal ? dt.getMinutes()    : dt.getUTCMinutes();

  // Moodle solo acepta minutos en múltiplos de 5 — redondear
  const minRedondeado = Math.min(55, Math.round(minute / 5) * 5);

  const fecha = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hora  = `${String(hour).padStart(2, "0")}:${String(minRedondeado).padStart(2, "0")}`;

  return { fecha, hora };
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

async function batchConfigRoutes(fastify) {

  /**
   * POST /api/evidencias/batch/duedate
   * Body: { evidenciaIds: string[], nuevaFecha: "2026-06-15T23:59" }
   *
   * Cambia la fecha de cierre (duedate/entrega) de N evidencias en batch.
   * Devuelve: { jobId, configChangeJobId }
   */
  fastify.post("/api/evidencias/batch/duedate", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id;
    const { evidenciaIds, nuevaFecha } = req.body || {};

    // ── Validaciones ─────────────────────────────────────────────────────────

    if (!Array.isArray(evidenciaIds) || evidenciaIds.length === 0) {
      return reply.code(400).send({ error: "Campo 'evidenciaIds' (array no vacío) requerido." });
    }
    if (!nuevaFecha) {
      return reply.code(400).send({ error: "Campo 'nuevaFecha' requerido (formato: 2026-06-15T23:59)." });
    }

    const parsed = parsearDatetime(nuevaFecha);
    if (!parsed) {
      return reply.code(400).send({ error: "Formato de fecha inválido. Usar: 2026-06-15T23:59 o ISO 8601." });
    }

    // Verificar que todas las evidencias existen y pertenecen al usuario
    const evs = await prisma.evidencia.findMany({
      where:   { id: { in: evidenciaIds } },
      include: { ficha: { select: { userId: true, id: true } } },
    });

    if (evs.length !== evidenciaIds.length) {
      return reply.code(404).send({ error: "Una o más evidencias no encontradas." });
    }

    const sinAcceso = evs.filter((ev) => ev.ficha.userId !== userId);
    if (sinAcceso.length > 0) {
      return reply.code(403).send({ error: "Sin acceso a una o más evidencias." });
    }

    const sinActId = evs.filter((ev) => !actIdFromHref(ev.href));
    if (sinActId.length > 0) {
      return reply.code(422).send({
        error: `${sinActId.length} evidencia(s) no tienen actId válido en su href.`,
        evidencias: sinActId.map((ev) => ({ id: ev.id, nombre: ev.nombre })),
      });
    }

    // Determinar fichaId si todas son de la misma ficha (para referencia)
    const fichaIds  = [...new Set(evs.map((ev) => ev.ficha.id))];
    const fichaId   = fichaIds.length === 1 ? fichaIds[0] : null;

    // ── Crear el job en DB ────────────────────────────────────────────────────

    const user = await prisma.user.findUnique({ where: { id: userId } });

    const configChangeJob = await prisma.configChangeJob.create({
      data: {
        userId,
        fichaId,
        evidenciaIds,
        campo:        "entregaFecha",
        valorDespues: `${parsed.fecha}T${parsed.hora}`,
        status:       "queued",
      },
    });

    const dbJob = await prisma.job.create({
      data: { userId, tipo: "batch-duedate", status: "queued" },
    });

    // ── Encolar en BullMQ ─────────────────────────────────────────────────────

    await cambiarFechaQueue.add("cambiarFecha", {
      configChangeJobId: configChangeJob.id,
      jobId:             dbJob.id,
      userId,
      evidenciaIds,
      nuevaFecha:        parsed.fecha,
      nuevaHora:         parsed.hora,
      zajunaUserEnc:     user.zajunaUserEnc,
      zajunaPassEnc:     user.zajunaPassEnc,
    });

    return reply.code(202).send({
      jobId:            dbJob.id,
      configChangeJobId: configChangeJob.id,
      total:            evidenciaIds.length,
      nuevaFecha:       parsed.fecha,
      nuevaHora:        parsed.hora,
    });
  });

  /**
   * GET /api/evidencias/batch/duedate/:configChangeJobId
   * Devuelve el estado y detalle de un ConfigChangeJob.
   */
  fastify.get("/api/evidencias/batch/duedate/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params;
    const job = await prisma.configChangeJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job no encontrado." });
    if (job.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });
    return reply.send(job);
  });
}

module.exports = batchConfigRoutes;
