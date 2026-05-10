const prisma = require("../db/client");

async function archivarRoutes(fastify) {
  // PATCH /api/fichas/:id  body: { archivada: boolean }
  fastify.patch("/api/fichas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { archivada } = req.body || {};
    if (typeof archivada !== "boolean") {
      return reply.code(400).send({ error: "Campo 'archivada' (boolean) requerido." });
    }

    const ficha = await prisma.ficha.findUnique({ where: { id: req.params.id } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const updated = await prisma.ficha.update({
      where: { id: ficha.id },
      data:  { archivedAt: archivada ? new Date() : null },
    });

    return { id: updated.id, archivedAt: updated.archivedAt };
  });

  // PATCH /api/evidencias/:id  body: { cerrada: boolean }
  fastify.patch("/api/evidencias/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { cerrada } = req.body || {};
    if (typeof cerrada !== "boolean") {
      return reply.code(400).send({ error: "Campo 'cerrada' (boolean) requerido." });
    }

    const ev = await prisma.evidencia.findUnique({
      where:   { id: req.params.id },
      include: { ficha: { select: { userId: true } } },
    });
    if (!ev)                              return reply.code(404).send({ error: "Evidencia no encontrada." });
    if (ev.ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const updated = await prisma.evidencia.update({
      where: { id: ev.id },
      data:  { cerradaAt: cerrada ? new Date() : null },
    });

    return { id: updated.id, cerradaAt: updated.cerradaAt };
  });

  // PATCH /api/evidencias/bulk  body: { ids: string[], cerrada: boolean }
  fastify.patch("/api/evidencias/bulk", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { ids, cerrada } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: "Campo 'ids' (array no vacío) requerido." });
    }
    if (typeof cerrada !== "boolean") {
      return reply.code(400).send({ error: "Campo 'cerrada' (boolean) requerido." });
    }

    const evs = await prisma.evidencia.findMany({
      where:   { id: { in: ids } },
      include: { ficha: { select: { userId: true } } },
    });

    if (evs.length !== ids.length) {
      return reply.code(404).send({ error: "Una o más evidencias no encontradas." });
    }

    const unauthorized = evs.some((ev) => ev.ficha.userId !== req.user.id);
    if (unauthorized) {
      return reply.code(403).send({ error: "Sin acceso a una o más evidencias." });
    }

    const result = await prisma.evidencia.updateMany({
      where: { id: { in: ids } },
      data:  { cerradaAt: cerrada ? new Date() : null },
    });

    return { actualizadas: result.count };
  });
}

module.exports = archivarRoutes;
