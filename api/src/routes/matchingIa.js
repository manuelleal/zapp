const prisma = require("../db/client");
const { matchingIaQueue } = require("../lib/queue");

// ─── Route plugin ─────────────────────────────────────────────────────────────

async function matchingIaRoutes(fastify) {

  // ── POST /api/matching/iniciar ─────────────────────────────────────────────
  // Body: { evidenciaIds?: string[] }   (empty/omitted = todas)
  // Creates a DB Job + enqueues a BullMQ matchingIa job.
  // Returns: { jobId, total }
  fastify.post("/api/matching/iniciar", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId      = req.user.id;
    const evidenciaIds = req.body?.evidenciaIds ?? [];

    // Resolve total count for the response
    let total;
    if (Array.isArray(evidenciaIds) && evidenciaIds.length > 0) {
      total = await prisma.evidencia.count({
        where: { id: { in: evidenciaIds }, ficha: { userId } },
      });
    } else {
      total = await prisma.evidencia.count({
        where: { ficha: { userId } },
      });
    }

    if (total === 0) {
      return reply.code(400).send({ error: "No hay evidencias para evaluar." });
    }

    // Create a DB Job record
    const job = await prisma.job.create({
      data: { userId, tipo: "matching-ia", status: "queued" },
    });

    // Enqueue BullMQ job
    await matchingIaQueue.add("matchingIa", {
      jobId:       job.id,
      userId,
      evidenciaIds: Array.isArray(evidenciaIds) && evidenciaIds.length > 0 ? evidenciaIds : null,
    });

    return reply.code(202).send({ jobId: job.id, total });
  });

  // ── GET /api/matching/propuestas ──────────────────────────────────────────
  // Returns all MatchingPropuesta for the user with estado="propuesto"
  // Includes evidencia { nombre, tipo } and rap { codigo, descripcion }
  fastify.get("/api/matching/propuestas", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId  = req.user.id;
    const estado  = req.query?.estado;   // optional filter: propuesto | aprobado | rechazado

    const where = { userId };
    if (estado) where.estado = estado;
    else         where.estado = "propuesto";  // default: only pending

    const propuestas = await prisma.matchingPropuesta.findMany({
      where,
      include: {
        evidencia: { select: { id: true, nombre: true, tipo: true } },
        rap:       { select: { id: true, codigo: true, descripcion: true } },
      },
      orderBy: [{ creadoAt: "desc" }],
    });

    return { propuestas };
  });

  // ── GET /api/matching/historial ───────────────────────────────────────────
  // Returns aprobadas + rechazadas (for the Historial section)
  fastify.get("/api/matching/historial", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id;

    const propuestas = await prisma.matchingPropuesta.findMany({
      where:   { userId, estado: { in: ["aprobado", "rechazado"] } },
      include: {
        evidencia: { select: { id: true, nombre: true, tipo: true } },
        rap:       { select: { id: true, codigo: true, descripcion: true } },
      },
      orderBy: [{ decidedAt: "desc" }],
    });

    return { propuestas };
  });

  // ── PATCH /api/matching/propuestas/:id ────────────────────────────────────
  // Body: { decision: "aprobado" | "rechazado" }
  // Updates estado + decidedAt.
  // If "aprobado": upserts RapEvidenciaRel — REQUIRES Módulo 4 to be merged.
  fastify.patch("/api/matching/propuestas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id;
    const { id } = req.params;
    const { decision } = req.body || {};

    if (!["aprobado", "rechazado"].includes(decision)) {
      return reply.code(400).send({ error: "decision debe ser 'aprobado' o 'rechazado'." });
    }

    // Fetch and authorize
    const propuesta = await prisma.matchingPropuesta.findUnique({ where: { id } });
    if (!propuesta)              return reply.code(404).send({ error: "Propuesta no encontrada." });
    if (propuesta.userId !== userId) return reply.code(403).send({ error: "Sin acceso." });

    const updated = await prisma.matchingPropuesta.update({
      where: { id },
      data:  { estado: decision, decidedAt: new Date() },
      include: {
        evidencia: { select: { id: true, nombre: true, tipo: true } },
        rap:       { select: { id: true, codigo: true, descripcion: true } },
      },
    });

    // If approved, upsert RapEvidenciaRel (Módulo 4 table).
    // Wrapped in try/catch because M4 may not be merged in this branch yet.
    if (decision === "aprobado") {
      try {
        await prisma.rapEvidenciaRel.upsert({
          where:  { rapId_evidenciaId: { rapId: propuesta.rapId, evidenciaId: propuesta.evidenciaId } },
          create: { rapId: propuesta.rapId, evidenciaId: propuesta.evidenciaId },
          update: {},
        });
      } catch (err) {
        // Expected if Módulo 4 (RapEvidenciaRel table) has not been merged yet.
        fastify.log.warn(`[matchingIa] No se pudo upsert RapEvidenciaRel (¿M4 no mergeado?): ${err.message}`);
      }
    }

    return { propuesta: updated };
  });

  // ── DELETE /api/matching/propuestas/:id ───────────────────────────────────
  // Permanently deletes a propuesta.
  fastify.delete("/api/matching/propuestas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id;
    const { id } = req.params;

    const propuesta = await prisma.matchingPropuesta.findUnique({ where: { id } });
    if (!propuesta)              return reply.code(404).send({ error: "Propuesta no encontrada." });
    if (propuesta.userId !== userId) return reply.code(403).send({ error: "Sin acceso." });

    await prisma.matchingPropuesta.delete({ where: { id } });
    return reply.code(200).send({ ok: true });
  });
}

module.exports = matchingIaRoutes;
