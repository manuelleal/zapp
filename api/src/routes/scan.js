const prisma = require("../db/client");
const { autoScanQueue } = require("../lib/queue");

async function scanRoutes(fastify) {
  // POST /api/scan/full — escanea TODAS las evidencias del usuario (ignora activaParaScan)
  fastify.post("/api/scan/full", { preHandler: fastify.authenticate }, async (req, reply) => {
    await autoScanQueue.add("scan-full", { userId: req.user.id, full: true });
    return reply.code(202).send({ ok: true, message: "Escaneo completo iniciado." });
  });

  // GET /api/scan/status — estado del auto-scan del usuario
  fastify.get("/api/scan/status", { preHandler: fastify.authenticate }, async (req) => {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { lastAutoScanAt: true },
    });

    const activeCount = await prisma.evidencia.count({
      where: { activaParaScan: true, cerradaAt: null, ficha: { userId: req.user.id, archivedAt: null } },
    });

    const lastAt = user?.lastAutoScanAt ?? null;
    // Próximo scan: si hay lastAt, suma 3h; si no, "pronto"
    const nextAt = lastAt ? new Date(new Date(lastAt).getTime() + 3 * 60 * 60 * 1000) : null;

    return { lastAutoScanAt: lastAt, nextAutoScanAt: nextAt, activeCount };
  });
}

module.exports = scanRoutes;
