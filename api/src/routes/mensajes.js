/**
 * api/src/routes/mensajes.js — Envío de mensajes a aprendices (inmediatos y programados).
 *
 * Canales soportados: "zajuna" (mensaje interno Moodle) | "email" (SMTP/Gmail vía configCorreo).
 *
 * Rutas de envío inmediato:
 *   POST   /api/mensajes                    — mensaje individual con destinatarios explícitos
 *   POST   /api/mensajes/enviar-masivo      — mensaje masivo con selector de evidencias y filtros
 *   GET    /api/mensajes/enviar-masivo/:jobId — estado del job de envío masivo (polling)
 *
 * Rutas de mensajes programados (recurrentes):
 *   POST   /api/mensajes/programados        — crear envío recurrente (filtro, no lista fija)
 *   GET    /api/mensajes/programados        — listar programados del usuario
 *   PATCH  /api/mensajes/programados/:id   — pausar/reanudar o cambiar intervalo/hora
 *   DELETE /api/mensajes/programados/:id   — eliminar
 *   El tick que los dispara corre en mensajesProgramadosWorker (cola mensajesProgramados,
 *   cada 10 min), que recalcula los destinatarios EN CADA corrida con el filtro guardado.
 *
 * Rutas auxiliares:
 *   GET    /api/mensajes/aprendices?fichaId — lista de aprendices + resumen de entregas
 *                                             para que el front calcule filtros (con pendientes,
 *                                             con desaprobadas, inactivos, etc.) sin otro round-trip.
 *   POST   /api/mensajes/sync-emails        — encola syncParticipantesWorker para traer emails
 *   GET    /api/mensajes/sync-emails/:jobId — estado del job de sync (polling)
 *   GET    /api/mensajes                   — historial de mensajes del usuario (con actaId/fichaId)
 *   GET    /api/mensajes/:id               — detalle de un mensaje
 *   GET    /api/mensajes/historial         — historial extendido con datos de ficha
 *
 * Lógica compartida con mensajesProgramadosWorker (regla §5.1: no duplicar):
 *   lib/mensajesMasivos.js contiene esEntregaDesaprobada, resumenEvidenciasPorAprendiz,
 *   aplanarEvidenciasToken, crearYEncolarEnvio. Ver ese módulo para entender
 *   qué se considera "pendiente" y "desaprobada" (umbral SENA 70/D).
 *
 * Anti-spam:
 *   - Mensajes programados: intervalo mínimo 1 día, máximo 60 días.
 *   - El worker aplica idempotencia (optimistic lock claim + un MensajeFormativo por corrida).
 *   - canal=zajuna requiere moodleId; canal=email requiere email — se valida antes de encolar.
 */
const prisma = require("../db/client");
const { mensajesQueue, syncParticipantesQueue, emailMasivoQueue } = require("../lib/queue");
const { filtrarAprendicesValidos } = require("../lib/aprendices");
// Lógica compartida con mensajesProgramadosWorker (regla §5.1: no duplicar).
const {
  esEntregaDesaprobada, resumenEvidenciasPorAprendiz,
  aplanarEvidenciasToken, crearYEncolarEnvio,
} = require("../lib/mensajesMasivos");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const FILTROS_PROGRAMADO  = ["todos", "con_pendientes", "con_desaprobadas", "inactivos", "nunca"];
const ALCANCES_PROGRAMADO = ["competencia", "todas", "ids"];

/**
 * Próxima ocurrencia de `hora` ("HH:mm", hora local del servidor) a partir de
 * `desde`. Si la hora de hoy ya pasó, cae a mañana — el intervaloDias aplica
 * ENTRE corridas, no a la primera.
 */
function calcularProximaEjecucion(hora, desde = new Date()) {
  const [h, m] = hora.split(":").map(Number);
  const prox = new Date(desde);
  prox.setHours(h, m, 0, 0);
  if (prox <= desde) prox.setDate(prox.getDate() + 1);
  return prox;
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
      let competenciaCodigo = null;
      if (!Array.isArray(evidenciaIds) || evidenciaIds.length === 0) {
        const yo = await prisma.user.findUnique({
          where:  { id: req.user.id },
          select: { competenciaCodigo: true },
        });
        competenciaCodigo = yo?.competenciaCodigo || null;
      }
      const resumen = await resumenEvidenciasPorAprendiz({
        fichaId, aprendizIds, evidenciaIds, competenciaCodigo,
      });
      for (const d of destinatariosEnriquecidos) {
        if (d.evidencias.length === 0) {
          d.evidencias = aplanarEvidenciasToken(resumen.get(d.aprendizId), !!incluirDesaprobadas);
        }
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

    const { mensaje, jobId } = await crearYEncolarEnvio({
      userId:        req.user.id,
      fichaId, canal, asunto, cuerpo,
      destinatarios: destinatariosEnriquecidos,
      templateTipo, actaId,
    });

    return reply.code(202).send({ jobId, mensajeFormativoId: mensaje.id });
  });

  // ══ MENSAJES PROGRAMADOS ══════════════════════════════════════════════════════
  // Envíos recurrentes (cada N días a una hora). Se guarda el FILTRO, no la lista
  // de destinatarios: mensajesProgramadosWorker la recalcula EN CADA corrida.

  // ── POST /api/mensajes/programados ───────────────────────────────────────────
  fastify.post("/api/mensajes/programados", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId, canal, asunto, cuerpo, templateTipo, filtroDestinatarios,
            alcanceEvidencias, evidenciaIds, incluirDesaprobadas, intervaloDias, hora } = req.body || {};

    if (!fichaId || !canal || !asunto || !cuerpo || !filtroDestinatarios || !intervaloDias || !hora) {
      return reply.code(400).send({ error: "fichaId, canal, asunto, cuerpo, filtroDestinatarios, intervaloDias y hora son requeridos." });
    }
    if (!["email", "zajuna"].includes(canal)) {
      return reply.code(400).send({ error: "Canal inválido. Valores: email, zajuna." });
    }
    if (!FILTROS_PROGRAMADO.includes(filtroDestinatarios)) {
      return reply.code(400).send({ error: `Filtro inválido. Valores: ${FILTROS_PROGRAMADO.join(", ")}.` });
    }
    const alcance = alcanceEvidencias || "competencia";
    if (!ALCANCES_PROGRAMADO.includes(alcance)) {
      return reply.code(400).send({ error: `Alcance inválido. Valores: ${ALCANCES_PROGRAMADO.join(", ")}.` });
    }
    if (alcance === "ids" && (!Array.isArray(evidenciaIds) || evidenciaIds.length === 0)) {
      return reply.code(400).send({ error: "Con alcance 'ids' debes enviar evidenciaIds." });
    }
    // Tope anti-spam: máximo 1 corrida por día, mínimo razonable de 1 día.
    const dias = parseInt(intervaloDias, 10);
    if (!Number.isFinite(dias) || dias < 1 || dias > 60) {
      return reply.code(400).send({ error: "intervaloDias debe estar entre 1 y 60." });
    }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) {
      return reply.code(400).send({ error: "hora debe tener formato HH:mm (24h)." });
    }

    const ficha = await prisma.ficha.findUnique({ where: { id: fichaId } });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta ficha." });

    if (canal === "email") {
      const config = await prisma.configCorreo.findUnique({ where: { userId: req.user.id } });
      if (!config) return reply.code(422).send({ error: "No hay configuración SMTP. Ve a Ajustes para configurarla." });
    }

    const programado = await prisma.mensajeProgramado.create({
      data: {
        userId:              req.user.id,
        fichaId, canal, asunto, cuerpo,
        templateTipo:        templateTipo || null,
        filtroDestinatarios,
        alcanceEvidencias:   alcance,
        evidenciaIds:        alcance === "ids" ? evidenciaIds.map(String) : null,
        incluirDesaprobadas: !!incluirDesaprobadas,
        intervaloDias:       dias,
        hora,
        proximaEjecucion:    calcularProximaEjecucion(hora),
      },
    });
    return reply.code(201).send(programado);
  });

  // ── GET /api/mensajes/programados ────────────────────────────────────────────
  fastify.get("/api/mensajes/programados", { preHandler: fastify.authenticate }, async (req) => {
    return prisma.mensajeProgramado.findMany({
      where:   { userId: req.user.id },
      orderBy: { creadoAt: "desc" },
      include: { ficha: { select: { codigo: true, nombre: true } } },
    });
  });

  // ── PATCH /api/mensajes/programados/:id ──────────────────────────────────────
  // Pausar/reanudar (pausado: bool) y/o cambiar intervaloDias/hora.
  fastify.patch("/api/mensajes/programados/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const prog = await prisma.mensajeProgramado.findUnique({ where: { id: req.params.id } });
    if (!prog)                       return reply.code(404).send({ error: "Programado no encontrado." });
    if (prog.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });

    const { pausado, intervaloDias, hora } = req.body || {};
    const data = {};
    if (typeof pausado === "boolean") data.pausadoAt = pausado ? new Date() : null;
    if (intervaloDias != null) {
      const dias = parseInt(intervaloDias, 10);
      if (!Number.isFinite(dias) || dias < 1 || dias > 60) return reply.code(400).send({ error: "intervaloDias debe estar entre 1 y 60." });
      data.intervaloDias = dias;
    }
    if (hora != null) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(hora)) return reply.code(400).send({ error: "hora debe tener formato HH:mm (24h)." });
      data.hora = hora;
      data.proximaEjecucion = calcularProximaEjecucion(hora);
    }
    if (Object.keys(data).length === 0) return reply.code(400).send({ error: "Nada que actualizar." });

    return prisma.mensajeProgramado.update({ where: { id: prog.id }, data });
  });

  // ── DELETE /api/mensajes/programados/:id ─────────────────────────────────────
  fastify.delete("/api/mensajes/programados/:id", { preHandler: fastify.authenticate }, async (req, reply) => {
    const prog = await prisma.mensajeProgramado.findUnique({ where: { id: req.params.id } });
    if (!prog)                       return reply.code(404).send({ error: "Programado no encontrado." });
    if (prog.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso." });
    await prisma.mensajeProgramado.delete({ where: { id: prog.id } });
    return { ok: true };
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
