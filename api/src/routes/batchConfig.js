const prisma = require("../db/client");
const { cambiarFechaQueue, cambiarConfigQueue } = require("../lib/queue");
const { actIdFromHref } = require("../lib/hrefUtils");

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function parsearDatetime(str) {
  if (!str || typeof str !== "string") return null;
  const dt = new Date(str.includes("T") ? str : str + "T00:00");
  if (isNaN(dt.getTime())) return null;

  const usarLocal = !str.endsWith("Z") && !str.match(/[+-]\d{2}:\d{2}$/);
  const year   = usarLocal ? dt.getFullYear()  : dt.getUTCFullYear();
  const month  = usarLocal ? dt.getMonth() + 1 : dt.getUTCMonth() + 1;
  const day    = usarLocal ? dt.getDate()       : dt.getUTCDate();
  const hour   = usarLocal ? dt.getHours()      : dt.getUTCHours();
  const minute = usarLocal ? dt.getMinutes()    : dt.getUTCMinutes();

  const minRedondeado = Math.min(55, Math.round(minute / 5) * 5);
  const fecha = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hora  = `${String(hour).padStart(2, "0")}:${String(minRedondeado).padStart(2, "0")}`;

  return { fecha, hora };
}

function redondearMinutos(horaStr) {
  if (!horaStr) return horaStr;
  const [h, m] = horaStr.split(":").map(Number);
  const mr = Math.min(55, Math.round(m / 5) * 5);
  return `${String(h).padStart(2, "0")}:${String(mr).padStart(2, "0")}`;
}

// ─── ROUTES ───────────────────────────────────────────────────────────────────

async function batchConfigRoutes(fastify) {

  // POST /api/evidencias/batch/duedate — cambio rápido de fecha de entrega (M2)
  fastify.post("/api/evidencias/batch/duedate", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id;
    const { evidenciaIds, nuevaFecha } = req.body || {};

    if (!Array.isArray(evidenciaIds) || evidenciaIds.length === 0)
      return reply.code(400).send({ error: "Campo 'evidenciaIds' (array no vacío) requerido." });
    if (!nuevaFecha)
      return reply.code(400).send({ error: "Campo 'nuevaFecha' requerido (formato: 2026-06-15T23:59)." });

    const parsed = parsearDatetime(nuevaFecha);
    if (!parsed)
      return reply.code(400).send({ error: "Formato de fecha inválido. Usar: 2026-06-15T23:59 o ISO 8601." });

    const evs = await prisma.evidencia.findMany({
      where:   { id: { in: evidenciaIds } },
      include: { ficha: { select: { userId: true, id: true } } },
    });
    if (evs.length !== evidenciaIds.length)
      return reply.code(404).send({ error: "Una o más evidencias no encontradas." });
    if (evs.some((ev) => ev.ficha.userId !== userId))
      return reply.code(403).send({ error: "Sin acceso a una o más evidencias." });
    const sinActId = evs.filter((ev) => !actIdFromHref(ev.href));
    if (sinActId.length > 0)
      return reply.code(422).send({ error: `${sinActId.length} evidencia(s) no tienen actId válido.`, evidencias: sinActId.map((ev) => ({ id: ev.id, nombre: ev.nombre })) });

    const fichaIds = [...new Set(evs.map((ev) => ev.ficha.id))];
    const user     = await prisma.user.findUnique({ where: { id: userId } });

    const configChangeJob = await prisma.configChangeJob.create({
      data: { userId, fichaId: fichaIds.length === 1 ? fichaIds[0] : null, evidenciaIds, campo: "entregaFecha", valorDespues: `${parsed.fecha}T${parsed.hora}`, status: "queued" },
    });
    const dbJob = await prisma.job.create({ data: { userId, tipo: "batch-duedate", status: "queued" } });

    await cambiarFechaQueue.add("cambiarFecha", {
      configChangeJobId: configChangeJob.id,
      jobId: dbJob.id,
      userId,
      evidenciaIds,
      nuevaFecha: parsed.fecha,
      nuevaHora:  parsed.hora,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: dbJob.id, configChangeJobId: configChangeJob.id, total: evidenciaIds.length, nuevaFecha: parsed.fecha, nuevaHora: parsed.hora });
  });

  // GET /api/evidencias/batch/duedate/:id — estado de un ConfigChangeJob de duedate
  fastify.get("/api/evidencias/batch/duedate/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params;
    const job = await prisma.configChangeJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job no encontrado." });
    if (job.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });
    return reply.send(job);
  });

  // POST /api/evidencias/batch/config — cambio masivo de cualquier campo de config (M3)
  fastify.post("/api/evidencias/batch/config", { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = req.user.id;
    const { evidenciaIds, cambios } = req.body || {};

    if (!Array.isArray(evidenciaIds) || evidenciaIds.length === 0)
      return reply.code(400).send({ error: "Campo 'evidenciaIds' (array no vacío) requerido." });
    if (!cambios || typeof cambios !== "object")
      return reply.code(400).send({ error: "Campo 'cambios' requerido." });

    const permitidos = ["entregaFecha", "entregaHora", "abrirFecha", "abrirHora", "limiteFecha", "limiteHora", "intentos"];
    const enviados   = permitidos.filter((k) => cambios[k] !== undefined && cambios[k] !== "");
    if (enviados.length === 0)
      return reply.code(400).send({ error: "Debe especificar al menos un campo en 'cambios'." });

    // Validar coherencia de fechas si ambas están presentes
    if (cambios.abrirFecha && cambios.entregaFecha) {
      const apertura = new Date(`${cambios.abrirFecha}T${cambios.abrirHora || "00:00"}`);
      const entrega  = new Date(`${cambios.entregaFecha}T${cambios.entregaHora || "23:55"}`);
      if (apertura > entrega)
        return reply.code(422).send({ error: "La fecha de apertura no puede ser posterior a la fecha de entrega." });
    }

    // Redondear minutos a múltiplos de 5
    const cambiosNorm = { ...cambios };
    for (const k of ["entregaHora", "abrirHora", "limiteHora"]) {
      if (cambiosNorm[k]) cambiosNorm[k] = redondearMinutos(cambiosNorm[k]);
    }

    const evs = await prisma.evidencia.findMany({
      where:   { id: { in: evidenciaIds } },
      include: { ficha: { select: { userId: true, id: true } } },
    });
    if (evs.length !== evidenciaIds.length)
      return reply.code(404).send({ error: "Una o más evidencias no encontradas." });
    if (evs.some((ev) => ev.ficha.userId !== userId))
      return reply.code(403).send({ error: "Sin acceso a una o más evidencias." });
    const sinActId = evs.filter((ev) => !actIdFromHref(ev.href));
    if (sinActId.length > 0)
      return reply.code(422).send({ error: `${sinActId.length} evidencia(s) no tienen actId válido.`, evidencias: sinActId.map((ev) => ({ id: ev.id, nombre: ev.nombre })) });

    const fichaIds = [...new Set(evs.map((ev) => ev.ficha.id))];
    const user     = await prisma.user.findUnique({ where: { id: userId } });

    const configChangeJob = await prisma.configChangeJob.create({
      data: { userId, fichaId: fichaIds.length === 1 ? fichaIds[0] : null, evidenciaIds, campo: enviados.join(","), valorDespues: JSON.stringify(cambiosNorm), status: "queued" },
    });
    const dbJob = await prisma.job.create({ data: { userId, tipo: "batch-config", status: "queued" } });

    await cambiarConfigQueue.add("cambiarConfig", {
      configChangeJobId: configChangeJob.id,
      jobId: dbJob.id,
      userId,
      evidenciaIds,
      cambios: cambiosNorm,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: dbJob.id, configChangeJobId: configChangeJob.id, total: evidenciaIds.length, cambios: cambiosNorm });
  });

  // GET /api/evidencias/batch/config/:id — estado de un ConfigChangeJob genérico
  fastify.get("/api/evidencias/batch/config/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { id } = req.params;
    const job = await prisma.configChangeJob.findUnique({ where: { id } });
    if (!job) return reply.code(404).send({ error: "Job no encontrado." });
    if (job.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });
    return reply.send(job);
  });
}

module.exports = batchConfigRoutes;
