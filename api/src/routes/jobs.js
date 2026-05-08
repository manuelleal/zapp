const prisma = require("../db/client");

async function jobsRoutes(fastify) {
  fastify.get("/api/jobs/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const job = await prisma.job.findUnique({ where: { id: req.params.id } });
    if (!job) return reply.code(404).send({ error: "Job no encontrado." });
    if (job.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    return {
      id:       job.id,
      status:   job.status,
      progreso: job.progreso,
      errorMsg: job.errorMsg ?? null,
      resultado: job.status === "done" ? job.resultado : null,
    };
  });
}

module.exports = jobsRoutes;
