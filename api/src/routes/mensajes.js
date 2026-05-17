const prisma = require("../db/client");
const { mensajesQueue } = require("../lib/queue");

// ─── Routes ───────────────────────────────────────────────────────────────────

async function mensajesRoutes(fastify) {

  // ── POST /api/mensajes ───────────────────────────────────────────────────────
  fastify.post("/api/mensajes", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { actaId, fichaId, canal, asunto, cuerpo, destinatarios } = req.body || {};

    if (!fichaId || !canal || !asunto || !cuerpo || !Array.isArray(destinatarios) || destinatarios.length === 0) {
      return reply.code(400).send({ error: "fichaId, canal, asunto, cuerpo y destinatarios son requeridos." });
    }

    const CANALES_VALIDOS = ["zajuna", "manual"];
    if (!CANALES_VALIDOS.includes(canal)) {
      return reply.code(400).send({ error: `Canal inválido. Valores válidos: ${CANALES_VALIDOS.join(", ")}.` });
    }

    const ficha = await prisma.ficha.findUnique({ where: { id: fichaId } });
    if (!ficha)                    return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta ficha." });

    if (canal === "manual") {
      const mensaje = await prisma.mensajeFormativo.create({
        data: {
          userId:        req.user.id,
          actaId:        actaId || null,
          fichaId,
          canal,
          asunto,
          cuerpo,
          destinatarios,
          estado:        "enviado",
          enviadoAt:     new Date(),
        },
      });
      return reply.code(201).send({ id: mensaje.id, estado: mensaje.estado });
    }

    // ── canal === "zajuna" ────────────────────────────────────────────────────

    const aprendizIds = destinatarios.map(d => d.aprendizId);
    const aprendices  = await prisma.aprendiz.findMany({
      where:  { id: { in: aprendizIds }, fichaId },
      select: { id: true, nombre: true, moodleId: true },
    });

    const aprendizMap = new Map(aprendices.map(a => [a.id, a]));

    const destinatariosEnriquecidos = destinatarios.map(d => {
      const a = aprendizMap.get(d.aprendizId);
      return {
        aprendizId: d.aprendizId,
        nombre:     a?.nombre   ?? null,
        moodleId:   a?.moodleId ?? null,
      };
    });

    const mensaje = await prisma.mensajeFormativo.create({
      data: {
        userId:        req.user.id,
        actaId:        actaId || null,
        fichaId,
        canal,
        asunto,
        cuerpo,
        destinatarios: destinatariosEnriquecidos,
        estado:        "pendiente",
      },
    });

    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { zajunaUserEnc: true, zajunaPassEnc: true },
    });

    await mensajesQueue.add("enviar", {
      mensajeId:     mensaje.id,
      userId:        req.user.id,
      destinatarios: destinatariosEnriquecidos,
      cuerpo,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(201).send({ id: mensaje.id, estado: mensaje.estado });
  });

  // ── GET /api/mensajes ────────────────────────────────────────────────────────
  fastify.get("/api/mensajes", { preHandler: fastify.authenticate }, async (req) => {
    const where = { userId: req.user.id };
    if (req.query?.actaId)  where.actaId  = req.query.actaId;
    if (req.query?.fichaId) where.fichaId = req.query.fichaId;

    const mensajes = await prisma.mensajeFormativo.findMany({
      where,
      orderBy: { creadoAt: "desc" },
    });

    return mensajes.map(m => ({
      id:                 m.id,
      canal:              m.canal,
      asunto:             m.asunto,
      estado:             m.estado,
      enviadoAt:          m.enviadoAt,
      creadoAt:           m.creadoAt,
      fichaId:            m.fichaId,
      actaId:             m.actaId,
      destinatariosCount: Array.isArray(m.destinatarios) ? m.destinatarios.length : 0,
    }));
  });

  // ── GET /api/mensajes/:id ────────────────────────────────────────────────────
  fastify.get("/api/mensajes/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const mensaje = await prisma.mensajeFormativo.findUnique({ where: { id: req.params.id } });
    if (!mensaje)                      return reply.code(404).send({ error: "Mensaje no encontrado." });
    if (mensaje.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a este mensaje." });

    return mensaje;
  });
}

module.exports = mensajesRoutes;
