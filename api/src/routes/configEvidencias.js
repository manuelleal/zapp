/**
 * api/src/routes/configEvidencias.js — Leer y guardar fechas/intentos de evidencias en Moodle.
 *
 * "Config" = los campos del formulario de edición de una tarea/foro en Moodle:
 *   abrirFecha/abrirHora, entregaFecha/entregaHora, limiteFecha/limiteHora, intentos.
 *
 * Rutas:
 *   PATCH  /api/evidencias/config/bulk             — guardar config en N evidencias (lote)
 *   POST   /api/fichas/:fichaId/config/leer-todo   — leer config de toda la ficha en 1 sesión (B1)
 *   GET    /api/fichas/:fichaId/config             — tabla de evidencias con configCache (B2)
 *   GET    /api/evidencias/:id/config              — config individual (con cache TTL 4h)
 *   PATCH  /api/evidencias/:id/config              — guardar config individual
 *
 * Colas usadas:
 *   configQueue      (config)         → leerConfigWorker / cambiarFechaWorker
 *   leerConfigQueue  (leerConfig)     → leerConfigWorker
 *   leerConfigLoteQueue (leerConfigLote) → leerConfigLoteWorker (sesión única, todas las evs)
 *
 * GOTCHA — dos caches desincronizados (bug diagnosticado 9-jun-2026):
 *   - EvidenciaConfig (tabla) guarda el `raw` HTML del formulario, usado para auditoría.
 *   - Evidencia.configCache (columna JSON inline) guarda el `config` parseado, usado por el front.
 *   Si EvidenciaConfig tiene una fila reciente pero Evidencia.configCache es null (ej. scan
 *   parcial donde se guardó el raw pero falló el parse), GET /api/evidencias/:id/config
 *   devolvería fromCache:true + config:null → el front queda vacío sin error ni jobId.
 *   Fix aplicado (línea ~206): se sirve cache SOLO si AMBOS existen y son recientes.
 *
 * GOTCHA — disabledIf de Moodle (ver CLAUDE.md §11.6 y scraper/configEvidenciasFetch.js):
 *   Moodle deshabilita por JS los selects de fecha cuando el checkbox [enabled] está apagado.
 *   Al leer el HTML con fetch/cheerio sin ejecutar JS, se obtienen valores stale de esos selects.
 *   El scraper emula esta regla eliminando los campos de fecha si [enabled] != "1"
 *   para evitar que Moodle rechace silenciosamente el POST (HTTP 200 sin guardar).
 */
const prisma = require("../db/client");
const { configQueue, leerConfigQueue, leerConfigLoteQueue } = require("../lib/queue");
const { encrypt } = require("../lib/crypto");
const { actIdFromHref } = require("../lib/hrefUtils");

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function getEvidenciaConAcceso(evidenciaId, userId) {
  const ev = await prisma.evidencia.findUnique({
    where:   { id: evidenciaId },
    include: { ficha: { select: { userId: true } } },
  });
  if (!ev) return { ev: null, error: "Evidencia no encontrada.", code: 404 };
  if (ev.ficha.userId !== userId) return { ev: null, error: "Sin acceso.", code: 403 };
  const actId = actIdFromHref(ev.href);
  if (!actId) return { ev: null, error: "Esta evidencia no tiene actId (href inválido).", code: 422 };
  return { ev, actId, error: null };
}

async function encolarConfigJob(userId, evidenciaId, actId, operation, config = null) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const job = await prisma.job.create({
    data: { userId, tipo: `config-${operation}`, status: "queued" },
  });

  await configQueue.add("config", {
    jobId:         job.id,
    userId,
    evidenciaId,
    actId,
    operation,
    config,
    zajunaUserEnc: user.zajunaUserEnc,
    zajunaPassEnc: user.zajunaPassEnc,
  });

  return job.id;
}

async function encolarLeerConfigJob(userId, evidenciaId, actId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });

  const job = await prisma.job.create({
    data: { userId, tipo: "config-leer", status: "queued" },
  });

  await leerConfigQueue.add("leerConfig", {
    jobId:         job.id,
    userId,
    evidenciaId,
    actId,
    zajunaUserEnc: user.zajunaUserEnc,
    zajunaPassEnc: user.zajunaPassEnc,
  });

  return job.id;
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

async function configEvidenciasRoutes(fastify) {

  // PATCH /api/evidencias/config/bulk
  // Body: { ids: string[], config: { abrirFecha?, abrirHora?, entregaFecha?, entregaHora?, limiteFecha?, limiteHora?, intentos? } }
  // IMPORTANT: register this before /:id/config to avoid param clash
  fastify.patch("/api/evidencias/config/bulk", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { ids, config } = req.body || {};

    if (!Array.isArray(ids) || ids.length === 0) {
      return reply.code(400).send({ error: "Campo 'ids' (array no vacío) requerido." });
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return reply.code(400).send({ error: "Campo 'config' (objeto) requerido." });
    }

    const evs = await prisma.evidencia.findMany({
      where:   { id: { in: ids } },
      include: { ficha: { select: { userId: true } } },
    });

    if (evs.length !== ids.length) {
      return reply.code(404).send({ error: "Una o más evidencias no encontradas." });
    }
    if (evs.some((ev) => ev.ficha.userId !== req.user.id)) {
      return reply.code(403).send({ error: "Sin acceso a una o más evidencias." });
    }

    const sinActId = evs.filter((ev) => !actIdFromHref(ev.href));
    if (sinActId.length > 0) {
      return reply.code(422).send({ error: `${sinActId.length} evidencia(s) sin actId válido.` });
    }

    const jobIds = [];
    for (const ev of evs) {
      const actId = actIdFromHref(ev.href);
      const jobId = await encolarConfigJob(req.user.id, ev.id, actId, "guardar", config);
      jobIds.push(jobId);
    }

    return reply.code(202).send({ jobIds });
  });

  // POST /api/fichas/:fichaId/config/leer-todo  (B1 — lector en lote)
  //   Encola UN job que lee la config de TODAS las evidencias de la ficha en una
  //   sola sesión Playwright. Devuelve 202 { jobId, total } para poder pollear.
  fastify.post("/api/fichas/:fichaId/config/leer-todo", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId } = req.params;

    // Opcional: subconjunto de evidencias a leer (las que el usuario seleccionó
    // en la Lista). Si no viene o viene vacío, se leen TODAS (comportamiento
    // histórico intacto).
    const idsPedidos = Array.isArray(req.body?.evidenciaIds) ? req.body.evidenciaIds : null;

    const ficha = await prisma.ficha.findUnique({
      where:   { id: fichaId },
      select:  { id: true, userId: true, courseId: true },
    });
    if (!ficha)                   return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta ficha." });

    const evs = await prisma.evidencia.findMany({
      where:  idsPedidos && idsPedidos.length > 0
        ? { fichaId, id: { in: idsPedidos } }   // solo las seleccionadas de esta ficha
        : { fichaId },                          // todas
      select: { id: true, href: true },
    });

    // Solo las que tienen actId válido (cmid en el href).
    const evidencias = evs
      .map((ev) => ({ evidenciaId: ev.id, actId: actIdFromHref(ev.href) }))
      .filter((e) => e.actId);

    if (evidencias.length === 0) {
      return reply.code(422).send({ error: "La ficha no tiene evidencias con actId válido para leer." });
    }

    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    const job  = await prisma.job.create({
      data: { userId: req.user.id, tipo: "config-leer-lote", status: "queued" },
    });

    await leerConfigLoteQueue.add("leerConfigLote", {
      jobId:         job.id,
      userId:        req.user.id,
      fichaId,
      courseId:      ficha.courseId,
      evidencias,
      zajunaUserEnc: user.zajunaUserEnc,
      zajunaPassEnc: user.zajunaPassEnc,
    });

    return reply.code(202).send({ jobId: job.id, total: evidencias.length });
  });

  // GET /api/fichas/:fichaId/config  (B2 — datos para la tabla editable)
  //   Devuelve TODAS las evidencias de la ficha con su configCache (lo que dejó
  //   el lector en lote). config = null si esa evidencia aún no se ha leído.
  fastify.get("/api/fichas/:fichaId/config", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { fichaId } = req.params;
    const ficha = await prisma.ficha.findUnique({
      where: { id: fichaId }, select: { id: true, userId: true },
    });
    if (!ficha)                       return reply.code(404).send({ error: "Ficha no encontrada." });
    if (ficha.userId !== req.user.id) return reply.code(403).send({ error: "Sin acceso a esta ficha." });

    const evs = await prisma.evidencia.findMany({
      where:  { fichaId },
      select: { id: true, nombre: true, tipo: true, href: true, configCache: true, configCacheAt: true },
      orderBy: { nombre: "asc" },
    });

    return evs.map((ev) => ({
      evidenciaId:   ev.id,
      nombre:        ev.nombre,
      tipo:          ev.tipo,
      actId:         actIdFromHref(ev.href),
      config:        ev.configCache,        // { tipo, abrirFecha, ... intentos } o null
      configCacheAt: ev.configCacheAt,
    }));
  });

  // GET /api/evidencias/:id/config
  //   1. Busca EvidenciaConfig más reciente < 4h → 200 { config, raw, fromCache, scannedAt }
  //   2. Fallback: configCache inline (legacy) < 4h
  //   3. ?force=1 fuerza re-lectura desde Moodle
  //   4. Sin cache → 202 { jobId } vía leerConfigQueue
  fastify.get("/api/evidencias/:id/config", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { ev, actId, error, code } = await getEvidenciaConAcceso(req.params.id, req.user.id);
    if (error) return reply.code(code).send({ error });

    const force = req.query?.force === "1" || req.query?.force === "true";
    const TTL_MS = 4 * 60 * 60 * 1000;

    if (!force) {
      // Check EvidenciaConfig table first
      const evConfig = await prisma.evidenciaConfig.findFirst({
        where:   { evidenciaId: ev.id },
        orderBy: { scannedAt: "desc" },
      });
      // Gotcha: EvidenciaConfig solo guarda `raw`; el `config` parseado vive en
      // OTRA columna (Evidencia.configCache). Si hay fila reciente pero
      // configCache es null, responder fromCache:true + config:null dejaba al
      // front sin datos NI jobId → pantalla vacía sin error. En ese caso NO
      // servimos cache: caemos al flujo de abajo que encola la re-lectura.
      if (evConfig && ev.configCache != null && (Date.now() - new Date(evConfig.scannedAt).getTime()) < TTL_MS) {
        return reply.code(200).send({
          config:    ev.configCache,
          raw:       evConfig.raw,
          fromCache: true,
          scannedAt: evConfig.scannedAt,
          cachedAt:  evConfig.scannedAt,
        });
      }

      // Fallback: inline configCache (legacy)
      if (ev.configCache && ev.configCacheAt && (Date.now() - new Date(ev.configCacheAt).getTime()) < TTL_MS) {
        return reply.code(200).send({
          config:    ev.configCache,
          fromCache: true,
          cachedAt:  ev.configCacheAt,
        });
      }
    }

    const jobId = await encolarLeerConfigJob(req.user.id, ev.id, actId);
    return reply.code(202).send({ jobId });
  });

  // PATCH /api/evidencias/:id/config
  // Body: { abrirFecha?, abrirHora?, entregaFecha?, entregaHora?, limiteFecha?, limiteHora?, intentos? }
  fastify.patch("/api/evidencias/:id/config", { preHandler: fastify.authenticate }, async (req, reply) => {
    const { ev, actId, error, code } = await getEvidenciaConAcceso(req.params.id, req.user.id);
    if (error) return reply.code(code).send({ error });

    const config = req.body || {};
    const camposPermitidos = ["abrirFecha", "abrirHora", "entregaFecha", "entregaHora", "limiteFecha", "limiteHora", "intentos"];
    const camposEnviados   = Object.keys(config).filter((k) => camposPermitidos.includes(k));

    if (camposEnviados.length === 0) {
      return reply.code(400).send({ error: "Debe enviar al menos un campo de configuración." });
    }

    const configFiltrada = Object.fromEntries(camposEnviados.map((k) => [k, config[k]]));
    const jobId = await encolarConfigJob(req.user.id, ev.id, actId, "guardar", configFiltrada);
    return reply.code(202).send({ jobId });
  });
}

module.exports = configEvidenciasRoutes;
