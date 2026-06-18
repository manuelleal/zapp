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

  // Jobs en curso del usuario, para el aviso global de "tareas en curso" del
  // header (sobrevive a la navegación porque vive en la DB, no en el componente).
  // Filtra por recientes (30 min) para no mostrar jobs "running" zombis que
  // quedaron de un worker muerto (ver post-mortem P2.1).
  fastify.get("/api/jobs/activos", { preHandler: fastify.authenticate }, async (req, reply) => {
    const desde = new Date(Date.now() - 30 * 60 * 1000);
    const jobs = await prisma.job.findMany({
      where: {
        userId:   req.user.id,
        status:   { in: ["queued", "running"] },
        creadoAt: { gte: desde },
      },
      orderBy: { creadoAt: "desc" },
      take:    20,
      select:  { id: true, tipo: true, status: true, progreso: true, fichaId: true, creadoAt: true },
    });
    return { jobs };
  });
}

module.exports = jobsRoutes;
