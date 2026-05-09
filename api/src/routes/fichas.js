const prisma = require("../db/client");
const { fichasQueue } = require("../lib/queue");

async function fichasRoutes(fastify) {
  // POST /api/fichas/scan — inicia scraping y retorna jobId
  fastify.post("/api/fichas/scan", { preHandler: fastify.authenticate }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user) return reply.code(404).send({ error: "Usuario no encontrado." });

    const job = await prisma.job.create({
      data: { userId: user.id, tipo: "fichas", status: "queued" },
    });

    await fichasQueue.add("scan", {
      jobId:            job.id,
      userId:           user.id,
      zajunaUserEnc:    user.zajunaUserEnc,
      zajunaPassEnc:    user.zajunaPassEnc,
      competenciaCodigo: user.competenciaCodigo,
    });

    return reply.code(202).send({ jobId: job.id });
  });

  // GET /api/fichas — fichas guardadas en DB para el usuario
  // Query: ?incluirArchivadas=1 para ver tambien las archivadas
  fastify.get("/api/fichas", { preHandler: fastify.authenticate }, async (req) => {
    const incluirArchivadas = req.query?.incluirArchivadas === "1";

    const where = { userId: req.user.id };
    if (!incluirArchivadas) where.archivedAt = null;

    const fichas = await prisma.ficha.findMany({
      where,
      orderBy: [{ archivedAt: "asc" }, { codigo: "asc" }],
      include: {
        evidencias: {
          where:   { cerradaAt: null },
          select:  { entregas: { select: { estado: true } } },
        },
      },
    });

    return {
      fichas: fichas.map(f => {
        let pendientes = 0;
        for (const ev of f.evidencias) {
          for (const e of ev.entregas) {
            if (e.estado === "pendiente") pendientes++;
          }
        }
        return {
          id:              f.id,
          codigo:          f.codigo,
          nombre:          f.nombre,
          courseId:        f.courseId,
          programa:        f.programa,
          archivedAt:      f.archivedAt,
          pendientes,
          tieneCodigoFicha: true,
        };
      }),
      otrosCursos: [],
    };
  });
}

module.exports = fichasRoutes;
