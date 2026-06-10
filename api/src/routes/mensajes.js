const prisma = require("../db/client");
const { mensajesQueue, syncParticipantesQueue, emailMasivoQueue } = require("../lib/queue");
const { filtrarAprendicesValidos } = require("../lib/aprendices");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Una entrega cuenta como DESAPROBADA si ya fue calificada y la nota no aprueba
 * (regla SENA universal: <70/100 o cualitativa D). Las "sin_entregar" NO cuentan
 * aquí — esas son pendientes, otra categoría en los filtros y en {{evidencias}}.
 */
function esEntregaDesaprobada(e) {
  if (e.estado === "sin_entregar") return false;
  if (/^d/i.test(String(e.notaCualitativa ?? "").trim())) return true;
  return e.notaActual != null && Number(e.notaActual) < 70;
}

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

  // ── GET /api/mensajes/aprendices?fichaId=... ─────────────────────────────────
  // Retorna lista de aprendices de una ficha con email, moodleId y último acceso,
  // filtrando nombres claramente inválidos (1-3 letras mayúsculas, etc.).
  fastify.get("/api/mensajes/aprendices", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId } = req.query || {};
    if (!fichaId) return reply.code(400).send({ error: "fichaId es requerido." });

    const ficha = await prisma.ficha.findUnique({ where: { id: fichaId } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta ficha." });

    const aprendicesRaw = await prisma.aprendiz.findMany({
      where:  { fichaId },
      select: { id: true, nombre: true, email: true, moodleId: true, ultimoAcceso: true },
      orderBy: { nombre: "asc" },
    });
    const validos = filtrarAprendicesValidos(aprendicesRaw);

    // Resumen de entregas por aprendiz (evidencias abiertas de la ficha) para que
    // el front calcule los filtros rápidos de destinatarios ("con pendientes",
    // "con desaprobadas") contra la selección de evidencias SIN otro round-trip.
    const entregas = await prisma.entrega.findMany({
      where: {
        aprendizId: { in: validos.map(a => a.id) },
        evidencia:  { fichaId, cerradaAt: null },
      },
      select: { aprendizId: true, evidenciaId: true, estado: true, notaActual: true, notaCualitativa: true },
    });
    const porAprendiz = new Map();
    for (const e of entregas) {
      if (!porAprendiz.has(e.aprendizId)) porAprendiz.set(e.aprendizId, []);
      porAprendiz.get(e.aprendizId).push({
        evidenciaId: e.evidenciaId,
        estado:      e.estado,
        desaprobada: esEntregaDesaprobada(e),
      });
    }
    return validos.map(a => ({ ...a, entregas: porAprendiz.get(a.id) ?? [] }));
  });

  // ── POST /api/mensajes/sync-emails ───────────────────────────────────────────
  // Encola un job que abre Playwright y trae los emails de todos los aprendices
  // de la ficha desde la página de participantes Moodle.
  fastify.post("/api/mensajes/sync-emails", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId } = req.body || {};
    if (!fichaId) return reply.code(400).send({ error: "fichaId es requerido." });

    const ficha = await prisma.ficha.findUnique({ where: { id: fichaId } });
    if (!ficha)                          return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id)    return reply.code(403).send({ error: "Sin acceso a esta ficha." });
    if (!ficha.courseId)                 return reply.code(422).send({ error: "La ficha no tiene courseId." });

    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { zajunaUserEnc: true, zajunaPassEnc: true },
    });

    const job = await syncParticipantesQueue.add("sync", {
      userId:        req.user.id,
      fichaId,
      courseId:      ficha.courseId,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: job.id });
  });

  // ── GET /api/mensajes/sync-emails/:jobId ─────────────────────────────────────
  // Estado de un job de sincronización de emails (polling).
  fastify.get("/api/mensajes/sync-emails/:jobId", { preHandler: fastify.authenticate }, async (req, reply) => {
    const job = await syncParticipantesQueue.getJob(req.params.jobId);
    if (!job) return reply.code(404).send({ error: "Job no encontrado." });
    const state = await job.getState();
    const data  = job.returnvalue ?? null;
    const fail  = job.failedReason ?? null;
    return { jobId: job.id, state, result: data, error: fail };
  });

  // ── POST /api/mensajes/enviar-masivo ─────────────────────────────────────────
  // Crea un MensajeFormativo y encola el envío. canal: "email" | "zajuna".
  fastify.post("/api/mensajes/enviar-masivo", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId, canal, asunto, cuerpo, destinatarios, templateTipo, actaId,
            evidenciaIds, incluirDesaprobadas } = req.body || {};

    if (!fichaId || !canal || !asunto || !cuerpo || !Array.isArray(destinatarios) || destinatarios.length === 0) {
      return reply.code(400).send({ error: "fichaId, canal, asunto, cuerpo y destinatarios son requeridos." });
    }
    if (!["email", "zajuna"].includes(canal)) {
      return reply.code(400).send({ error: "Canal inválido. Valores: email, zajuna." });
    }

    const ficha = await prisma.ficha.findUnique({ where: { id: fichaId } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta ficha." });

    if (canal === "email") {
      const config = await prisma.configCorreo.findUnique({ where: { userId: req.user.id } });
      if (!config) {
        return reply.code(422).send({ error: "No hay configuración SMTP. Ve a Ajustes para configurarla." });
      }
    }

    // Enriquecer destinatarios con datos de DB (nombre, email, moodleId)
    const aprendizIds = destinatarios.map(d => d.aprendizId).filter(Boolean);
    const aprendices = aprendizIds.length > 0
      ? await prisma.aprendiz.findMany({
          where:  { id: { in: aprendizIds }, fichaId },
          select: { id: true, nombre: true, email: true, moodleId: true },
        })
      : [];
    const mapaAprendiz = new Map(aprendices.map(a => [a.id, a]));

    const destinatariosEnriquecidos = destinatarios.map(d => {
      const a = mapaAprendiz.get(d.aprendizId);
      return {
        aprendizId: d.aprendizId,
        nombre:     d.nombre   ?? a?.nombre   ?? null,
        email:      d.email    ?? a?.email    ?? null,
        moodleId:   a?.moodleId ?? null,
        evidencias: Array.isArray(d.evidencias) ? d.evidencias : [],
        ficha:      d.ficha ?? `${ficha.codigo}`,
        instructor: d.instructor ?? null,
      };
    });

    // ── Auto-poblar {{evidencias}} desde DB ─────────────────────────────────────
    // Si el cuerpo/asunto usa el token y el front no mandó la lista, calculamos
    // los pendientes REALES por aprendiz. Alcance de las evidencias consideradas:
    //   1. `evidenciaIds` del selector del front → SOLO esas (el `fichaId` del
    //      where las restringe a la ficha ya verificada del usuario, así no se
    //      cuelan evidencias de otro tenant ni de otra ficha).
    //   2. Sin selección → fallback por la COMPETENCIA del instructor: en una
    //      ficha dan clase varios instructores y no debemos reportar al aprendiz
    //      pendientes de competencias ajenas (el código va en el nombre canónico
    //      GA{n}-{comp}-AA{m}-EV{nn} de la evidencia).
    //   3. Instructor sin competencia → todas las activas (comportamiento previo).
    // Con `incluirDesaprobadas` se suman las calificadas que no aprueban (<70 o
    // cualitativa D), etiquetadas — paridad con la Extensión Z, que reporta
    // pendientes Y desaprobadas.
    const usaTokenEvidencias = /\{\{evidencias\}\}/i.test(cuerpo) || /\{\{evidencias\}\}/i.test(asunto);
    if (usaTokenEvidencias && destinatariosEnriquecidos.some(d => d.evidencias.length === 0)) {
      const whereEvidencia = { fichaId, cerradaAt: null };
      if (Array.isArray(evidenciaIds) && evidenciaIds.length > 0) {
        whereEvidencia.id = { in: evidenciaIds.map(String) };
      } else {
        whereEvidencia.activaParaScan = true;
        const yo = await prisma.user.findUnique({
          where:  { id: req.user.id },
          select: { competenciaCodigo: true },
        });
        if (yo?.competenciaCodigo) whereEvidencia.nombre = { contains: yo.competenciaCodigo };
      }

      const entregasToken = await prisma.entrega.findMany({
        where: {
          aprendizId: { in: aprendizIds },
          evidencia:  whereEvidencia,
        },
        select: {
          aprendizId: true, estado: true, notaActual: true, notaCualitativa: true,
          evidencia: { select: { nombre: true } },
        },
        orderBy: { evidencia: { nombre: "asc" } },
      });
      const evidenciasPorAprendiz = new Map();
      for (const e of entregasToken) {
        let etiqueta = null;
        if (e.estado === "sin_entregar")                          etiqueta = e.evidencia.nombre;
        else if (incluirDesaprobadas && esEntregaDesaprobada(e))  etiqueta = `${e.evidencia.nombre} (desaprobada — corregir y reenviar)`;
        if (!etiqueta) continue;
        if (!evidenciasPorAprendiz.has(e.aprendizId)) evidenciasPorAprendiz.set(e.aprendizId, []);
        evidenciasPorAprendiz.get(e.aprendizId).push(etiqueta);
      }
      for (const d of destinatariosEnriquecidos) {
        if (d.evidencias.length === 0) d.evidencias = evidenciasPorAprendiz.get(d.aprendizId) ?? [];
      }
    }

    // ── Validación por canal ────────────────────────────────────────────────────
    // canal=email → requiere al menos un destinatario con email.
    // canal=zajuna → requiere al menos un destinatario con moodleId
    //   (el worker `mensajeFormativoWorker` exige moodleId para abrir el chat
    //    Moodle; sin él el envío falla silenciosamente).
    if (canal === "email") {
      const conEmail = destinatariosEnriquecidos.filter(d => d.email).length;
      if (conEmail === 0) {
        return reply.code(422).send({
          error: "Ningún destinatario tiene email. Sincroniza los emails desde Zajuna primero (botón 'Sincronizar emails' en la página Mensajes).",
        });
      }
    } else if (canal === "zajuna") {
      const conMoodle = destinatariosEnriquecidos.filter(d => d.moodleId).length;
      if (conMoodle === 0) {
        return reply.code(422).send({
          error: "Ningún destinatario tiene moodleId. Re-escanea las evidencias de la ficha para poblar los moodleId de los aprendices.",
        });
      }
    }

    const mensaje = await prisma.mensajeFormativo.create({
      data: {
        userId:        req.user.id,
        actaId:        actaId || null,
        fichaId,
        canal,
        asunto,
        cuerpo,
        destinatarios: destinatariosEnriquecidos,
        templateTipo:  templateTipo || null,
        estado:        "pendiente",
      },
    });

    let jobId = null;
    if (canal === "email") {
      const job = await emailMasivoQueue.add("enviar", {
        mensajeFormativoId: mensaje.id,
        userId: req.user.id,
      });
      jobId = job.id;
    } else {
      // canal=zajuna → usa el worker existente de mensajes (chat interno Moodle)
      const user = await prisma.user.findUnique({
        where:  { id: req.user.id },
        select: { zajunaUserEnc: true, zajunaPassEnc: true },
      });
      const job = await mensajesQueue.add("enviar", {
        mensajeId:     mensaje.id,
        userId:        req.user.id,
        destinatarios: destinatariosEnriquecidos,
        cuerpo,
        zajunaUserEnc: user.zajunaUserEnc,
        zajunaPassEnc: user.zajunaPassEnc,
      });
      jobId = job.id;
    }

    return reply.code(202).send({ jobId, mensajeFormativoId: mensaje.id });
  });

  // ── GET /api/mensajes/enviar-masivo/:jobId ───────────────────────────────────
  // Estado del job de envío masivo (polling). Busca primero en emailMasivo, luego mensajes.
  fastify.get("/api/mensajes/enviar-masivo/:jobId", { preHandler: fastify.authenticate }, async (req, reply) => {
    const id = req.params.jobId;
    let job = await emailMasivoQueue.getJob(id);
    let queue = "emailMasivo";
    if (!job) { job = await mensajesQueue.getJob(id); queue = "mensajes"; }
    if (!job) return reply.code(404).send({ error: "Job no encontrado." });
    const state = await job.getState();
    return {
      jobId:  job.id,
      queue,
      state,
      result: job.returnvalue ?? null,
      error:  job.failedReason ?? null,
    };
  });

  // ── GET /api/mensajes/historial ──────────────────────────────────────────────
  fastify.get("/api/mensajes/historial", { preHandler: fastify.authenticate }, async (req) => {
    const where = { userId: req.user.id };
    if (req.query?.fichaId) where.fichaId = req.query.fichaId;

    const mensajes = await prisma.mensajeFormativo.findMany({
      where,
      orderBy: [{ enviadoAt: "desc" }, { creadoAt: "desc" }],
      take: 100,
      include: { ficha: { select: { codigo: true, nombre: true } } },
    });

    return mensajes.map(m => ({
      id:                 m.id,
      canal:              m.canal,
      asunto:             m.asunto,
      estado:             m.estado,
      enviadoAt:          m.enviadoAt,
      creadoAt:           m.creadoAt,
      fichaId:            m.fichaId,
      ficha:              m.ficha,
      actaId:             m.actaId,
      errorMsg:           m.errorMsg,
      destinatariosCount: Array.isArray(m.destinatarios) ? m.destinatarios.length : 0,
    }));
  });
}

module.exports = mensajesRoutes;
