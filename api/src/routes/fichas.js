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

  // POST /api/fichas — crear ficha manualmente
  fastify.post("/api/fichas", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { codigo, courseId, nombre, programa } = req.body || {};
    if (!codigo || !courseId) return reply.code(400).send({ error: "codigo y courseId requeridos." });
    if (isNaN(parseInt(courseId, 10))) return reply.code(400).send({ error: "courseId debe ser un número entero." });

    const existing = await prisma.ficha.findUnique({
      where: { userId_codigo: { userId: req.user.id, codigo: String(codigo) } },
    });
    if (existing) return reply.code(409).send({ error: "Ya existe una ficha con ese código." });

    const ficha = await prisma.ficha.create({
      data: {
        userId:   req.user.id,
        codigo:   String(codigo),
        courseId: parseInt(courseId, 10),
        nombre:   nombre || "",
        programa: programa || "",
      },
    });
    return reply.code(201).send({ id: ficha.id, codigo: ficha.codigo, courseId: ficha.courseId });
  });

  // PUT /api/fichas/:id — editar ficha
  fastify.put("/api/fichas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({ where: { id: req.params.id } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const { codigo, nombre, programa, courseId } = req.body || {};
    if (courseId !== undefined && isNaN(parseInt(courseId, 10))) {
      return reply.code(400).send({ error: "courseId debe ser un número entero." });
    }
    const updated = await prisma.ficha.update({
      where: { id: ficha.id },
      data: {
        ...(codigo   ? { codigo }             : {}),
        ...(nombre   !== undefined ? { nombre }   : {}),
        ...(programa !== undefined ? { programa } : {}),
        ...(courseId ? { courseId: parseInt(courseId, 10) } : {}),
      },
    });
    return { id: updated.id, codigo: updated.codigo, nombre: updated.nombre, programa: updated.programa };
  });

  // DELETE /api/fichas/:id — eliminar ficha (solo si no tiene evidencias con entregas)
  fastify.delete("/api/fichas/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ficha = await prisma.ficha.findUnique({
      where:   { id: req.params.id },
      include: { evidencias: { include: { entregas: { take: 1 } } } },
    });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const tieneEntregas = ficha.evidencias.some(ev => ev.entregas.length > 0);
    if (tieneEntregas) return reply.code(409).send({ error: "No se puede eliminar: la ficha tiene entregas registradas." });

    await prisma.ficha.delete({ where: { id: ficha.id } });
    return { ok: true };
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

    // Conteo de archivadas (siempre, para que la UI pueda dar pista
    // "todas estan archivadas, activa Ver archivadas")
    const archivadasCount = await prisma.ficha.count({
      where: { userId: req.user.id, archivedAt: { not: null } },
    });

    return {
      archivadasCount,
      fichas: fichas.map(f => {
        let pendientes    = 0;
        let totalEntregas = 0;
        for (const ev of f.evidencias) {
          for (const e of ev.entregas) {
            totalEntregas++;
            if (e.estado === "pendiente") pendientes++;
          }
        }
        return {
          id:               f.id,
          codigo:           f.codigo,
          nombre:           f.nombre,
          courseId:         f.courseId,
          programa:         f.programa,
          archivedAt:       f.archivedAt,
          // null = ficha jamas escaneada (sin entregas en DB)
          pendientes:       totalEntregas === 0 ? null : pendientes,
          tieneCodigoFicha: true,
        };
      }),
      otrosCursos: [],
    };
  });
}

module.exports = fichasRoutes;
