const prisma = require("../db/client");
const { evidenciasQueue } = require("../lib/queue");

async function evidenciasRoutes(fastify) {
  // POST /api/fichas/:fichaId/evidencias/scan — inicia scraping de evidencias
  fastify.post("/api/fichas/:fichaId/evidencias/scan", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({ where: { id: req.params.fichaId } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const job = await prisma.job.create({
      data: { userId: user.id, tipo: "evidencias", fichaId: ficha.id, status: "queued" },
    });

    await evidenciasQueue.add("scan", {
      jobId:             job.id,
      userId:            user.id,
      fichaId:           ficha.id,
      courseId:          ficha.courseId,
      competenciaCodigo: user.competenciaCodigo,
      zajunaUserEnc:     user.zajunaUserEnc,
      zajunaPassEnc:     user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: job.id });
  });

  // GET /api/fichas/:fichaId/evidencias — evidencias guardadas con conteos de entrega
  fastify.get("/api/fichas/:fichaId/evidencias", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({ where: { id: req.params.fichaId } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const evidencias = await prisma.evidencia.findMany({
      where:   { fichaId: ficha.id },
      include: { entregas: { select: { estado: true, fechaScan: true } } },
      orderBy: { nombre: "asc" },
    });

    return {
      evidencias: evidencias.map(ev => {
        const pendientes  = ev.entregas.filter(e => e.estado === "pendiente").length;
        const calificados = ev.entregas.filter(e => e.estado === "calificado").length;
        const sinEntregar = ev.entregas.filter(e => e.estado === "sin_entregar").length;
        const ultimoScan  = ev.entregas.length
          ? ev.entregas.reduce((max, e) => (e.fechaScan > max ? e.fechaScan : max), ev.entregas[0].fechaScan)
          : null;

        return {
          id:          ev.id,
          nombre:      ev.nombre,
          href:        ev.href,
          tipo:        ev.tipo,
          pendientes,
          calificados,
          sinEntregar,
          total:       ev.entregas.length,
          ultimoScan,
        };
      }),
    };
  });
}

module.exports = evidenciasRoutes;
