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
  // Query: ?incluirCerradas=1 para incluir tambien las cerradas
  fastify.get("/api/fichas/:fichaId/evidencias", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({ where: { id: req.params.fichaId } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const incluirCerradas = req.query?.incluirCerradas === "1";

    const evidencias = await prisma.evidencia.findMany({
      where:   { fichaId: ficha.id },
      include: { entregas: { select: { estado: true, fechaScan: true } } },
      orderBy: [{ cerradaAt: "asc" }, { nombre: "asc" }],
    });

    const mapped = evidencias.map(ev => {
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
        cerradaAt:   ev.cerradaAt,
        pendientes,
        calificados,
        sinEntregar,
        total:       ev.entregas.length,
        ultimoScan,
      };
    });

    return {
      evidencias: incluirCerradas ? mapped : mapped.filter(e => !e.cerradaAt),
      cerradasCount: mapped.filter(e => e.cerradaAt).length,
    };
  });

  // GET /api/evidencias/:evidenciaId/entregas — lista de aprendices con estado para esta evidencia
  // Query: ?estado=pendiente|calificado|sin_entregar (filtro opcional)
  fastify.get("/api/evidencias/:evidenciaId/entregas", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ev = await prisma.evidencia.findUnique({
      where:   { id: req.params.evidenciaId },
      include: { ficha: { select: { userId: true } } },
    });
    if (!ev)                              return reply.code(404).send({ error: "Evidencia no encontrada." });
    if (ev.ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const filtroEstado = req.query?.estado || null;

    const entregas = await prisma.entrega.findMany({
      where: {
        evidenciaId: ev.id,
        ...(filtroEstado ? { estado: filtroEstado } : {}),
      },
      include: { aprendiz: { select: { id: true, nombre: true, moodleId: true } } },
      orderBy: [{ estado: "asc" }, { aprendiz: { nombre: "asc" } }],
    });

    // Extraer actId del href de la evidencia para construir URLs
    const actIdMatch = ev.href.match(/[?&]id=(\d+)/);
    const actId = actIdMatch ? actIdMatch[1] : null;

    return {
      evidenciaId:   ev.id,
      evidenciaNombre: ev.nombre,
      actId,
      entregas: entregas.map(e => ({
        id:        e.id,
        estado:    e.estado,
        fechaScan: e.fechaScan,
        aprendiz: {
          id:       e.aprendiz.id,
          nombre:   e.aprendiz.nombre,
          moodleId: e.aprendiz.moodleId,
        },
      })),
    };
  });
}

module.exports = evidenciasRoutes;
