/**
 * api/src/routes/foroRating.js — Sprint 2.5 FIX 4
 *
 * Endpoint para calificar posts de un foro Moodle desde la app.
 */

const prisma = require("../db/client");
const { foroRatingQueue, foroDescubrirQueue } = require("../lib/queue");

function actIdFromHref(href) {
  if (!href) return null;
  const m = href.match(/[?&]id=(\d+)/);
  return m ? m[1] : null;
}

async function foroRatingRoutes(fastify) {
  // PATCH /api/evidencias/:id/foro/calificar
  // Body: { ratings: [{ moodleUserId: string, nota: number|string }] }
  fastify.patch("/api/evidencias/:id/foro/calificar", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ev = await prisma.evidencia.findUnique({
      where:   { id: req.params.id },
      include: { ficha: { select: { userId: true } } },
    });
    if (!ev) return reply.code(404).send({ error: "Evidencia no encontrada." });
    if (ev.ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });
    if (ev.tipo !== "forum") {
      return reply.code(422).send({ error: "Esta evidencia no es un foro (tipo=" + ev.tipo + ")." });
    }
    const actId = actIdFromHref(ev.href);
    if (!actId) return reply.code(422).send({ error: "Evidencia sin actId válido." });

    const { ratings } = req.body || {};
    if (!Array.isArray(ratings) || ratings.length === 0) {
      return reply.code(400).send({ error: "Campo 'ratings' (array no vacío) requerido." });
    }
    for (const r of ratings) {
      if (!r || typeof r !== "object") return reply.code(400).send({ error: "Item de rating inválido." });
      if (!r.moodleUserId)              return reply.code(400).send({ error: "Falta moodleUserId en un rating." });
      if (r.nota === undefined || r.nota === null || r.nota === "") {
        return reply.code(400).send({ error: "Falta nota en un rating." });
      }
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const job = await prisma.job.create({
      data: { userId: req.user.id, tipo: "foro-rating", status: "queued" },
    });

    await foroRatingQueue.add("foroRating", {
      jobId:         job.id,
      userId:        req.user.id,
      evidenciaId:   ev.id,
      actId,
      ratings:       ratings.map((r) => ({ moodleUserId: String(r.moodleUserId), nota: r.nota })),
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: job.id });
  });

  // POST /api/evidencias/:id/foro/descubrir-pendientes
  // Scrapeo en vivo del foro Moodle para identificar aprendices que publicaron
  // pero aún no tienen rating asignado.
  fastify.post("/api/evidencias/:id/foro/descubrir-pendientes", { preHandler: fastify.authenticate }, async (req, reply) => {
    const ev = await prisma.evidencia.findUnique({
      where:   { id: req.params.id },
      include: { ficha: { select: { userId: true } } },
    });
    if (!ev) return reply.code(404).send({ error: "Evidencia no encontrada." });
    if (ev.ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });
    if (ev.tipo !== "forum") {
      return reply.code(422).send({ error: "Esta evidencia no es un foro (tipo=" + ev.tipo + ")." });
    }
    const actId = actIdFromHref(ev.href);
    if (!actId) return reply.code(422).send({ error: "Evidencia sin actId válido." });

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });

    const job = await prisma.job.create({
      data: { userId: req.user.id, tipo: "foro-descubrir", status: "queued" },
    });

    await foroDescubrirQueue.add("foroDescubrir", {
      jobId:         job.id,
      userId:        req.user.id,
      evidenciaId:   ev.id,
      actId,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: job.id });
  });
}

module.exports = foroRatingRoutes;
