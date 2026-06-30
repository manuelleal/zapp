const nodemailer = require("nodemailer");
const prisma = require("../db/client");
const { encrypt, decrypt } = require("../lib/crypto");
const { descubrirCompetenciasQueue } = require("../lib/queue");
const { saveSession } = require("../lib/sessionStore");
const { humanizarErrorSMTP } = require("../lib/smtpErrors");
// Criterio único de superadmin (rol="superadmin" O email===SUPERADMIN_EMAIL).
// Mismo helper que usa admin.js para que ambos módulos decidan igual (ver lib/roles.js).
const { esSuperadmin } = require("../lib/roles");

// ─── Routes ───────────────────────────────────────────────────────────────────

async function ajustesRoutes(fastify) {

  // ── GET /api/ajustes/correo ─────────────────────────────────────────────────
  fastify.get("/api/ajustes/correo", { preHandler: fastify.authenticate }, async (req) => {
    const config = await prisma.configCorreo.findUnique({
      where: { userId: req.user.id },
      select: {
        id: true,
        smtpHost: true,
        smtpPort: true,
        smtpUser: true,
        fromNombre: true,
        creadaAt: true,
        actualizadaAt: true,
      },
    });
    return config; // null si no existe
  });

  // ── POST /api/ajustes/correo ────────────────────────────────────────────────
  fastify.post("/api/ajustes/correo", {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: "object",
        required: ["smtpHost", "smtpUser"],
        properties: {
          smtpHost:   { type: "string", minLength: 1 },
          smtpPort:   { type: "number" },
          smtpUser:   { type: "string", minLength: 1 },
          smtpPass:   { type: "string" },
          fromNombre: { type: "string" },
        },
      },
    },
  }, async (req, reply) => {
    const { smtpHost, smtpPort, smtpUser, smtpPass, fromNombre } = req.body || {};
    const port = Number.isFinite(smtpPort) ? Number(smtpPort) : 587;

    const existente = await prisma.configCorreo.findUnique({ where: { userId: req.user.id } });

    // Si no hay smtpPass nuevo, requerir que exista una previa.
    if (!smtpPass || !smtpPass.trim()) {
      if (!existente) {
        return reply.code(400).send({ error: "smtpPass es requerido al crear la configuración." });
      }
      // Update sin tocar la contraseña
      const updated = await prisma.configCorreo.update({
        where: { userId: req.user.id },
        data:  {
          smtpHost,
          smtpPort: port,
          smtpUser,
          fromNombre: fromNombre ?? null,
        },
      });
      return reply.code(200).send({ id: updated.id, ok: true });
    }

    const smtpPassEnc = encrypt(smtpPass);
    const config = await prisma.configCorreo.upsert({
      where:  { userId: req.user.id },
      create: { userId: req.user.id, smtpHost, smtpPort: port, smtpUser, smtpPassEnc, fromNombre: fromNombre ?? null },
      update: { smtpHost, smtpPort: port, smtpUser, smtpPassEnc, fromNombre: fromNombre ?? null },
    });
    return reply.code(200).send({ id: config.id, ok: true });
  });

  // ── POST /api/ajustes/correo/probar ─────────────────────────────────────────
  fastify.post("/api/ajustes/correo/probar", { preHandler: fastify.authenticate }, async (req, reply) => {
    const config = await prisma.configCorreo.findUnique({ where: { userId: req.user.id } });
    if (!config) {
      return reply.code(404).send({ ok: false, error: "No hay configuración SMTP guardada." });
    }
    let pass;
    try { pass = decrypt(config.smtpPassEnc); }
    catch (e) { return reply.code(500).send({ ok: false, error: "No se pudo descifrar la contraseña SMTP." }); }

    const transporter = nodemailer.createTransport({
      host:   config.smtpHost,
      port:   config.smtpPort,
      secure: config.smtpPort === 465,
      auth:   { user: config.smtpUser, pass },
    });

    try {
      await transporter.verify();
      return { ok: true };
    } catch (err) {
      // Traduce el error crudo de SMTP a una pista accionable en español (Gmail app
      // password, Outlook con SMTP Auth deshabilitado, credenciales, host/puerto…).
      return reply.code(200).send({ ok: false, error: humanizarErrorSMTP(err.message || "") });
    }
  });

  // ── DELETE /api/ajustes/correo ──────────────────────────────────────────────
  fastify.delete("/api/ajustes/correo", { preHandler: fastify.authenticate }, async (req, reply) => {
    await prisma.configCorreo.deleteMany({ where: { userId: req.user.id } });
    return reply.code(200).send({ ok: true });
  });

  // ── GET /api/ajustes/zajuna ───────────────────────────────────────────────
  // Estado de las credenciales de Zajuna del instructor: su documento (usuario)
  // y si quedaron inválidas (`credsInvalidasAt != null` → el banner de la UI pide
  // actualizar la contraseña porque un worker detectó "Credenciales incorrectas").
  fastify.get("/api/ajustes/zajuna", { preHandler: fastify.authenticate }, async (req) => {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { zajunaUserEnc: true, zajunaCredsInvalidasAt: true },
    });
    let zajunaUser = "";
    try { if (user?.zajunaUserEnc) zajunaUser = decrypt(user.zajunaUserEnc); } catch { /* clave de cifrado rotada */ }
    return { zajunaUser, credsInvalidasAt: user?.zajunaCredsInvalidasAt ?? null };
  });

  // ── POST /api/ajustes/zajuna ──────────────────────────────────────────────
  // Actualiza la contraseña (y opcionalmente el documento) de Zajuna. Sofía (admin
  // del SENA) obliga a rotar la clave seguido; cuando el instructor la cambia en
  // Zajuna debe re-guardarla aquí o todos los scans fallan con la clave vieja.
  // Al guardar: limpia el flag de inválidas y BORRA la sesión Moodle cacheada en
  // Redis para forzar un login fresco con la clave nueva en el próximo job.
  fastify.post("/api/ajustes/zajuna", {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: "object",
        required: ["zajunaPass"],
        properties: {
          zajunaUser: { type: "string" },
          zajunaPass: { type: "string", minLength: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { zajunaUser, zajunaPass } = req.body || {};

    const data = { zajunaPassEnc: encrypt(zajunaPass), zajunaCredsInvalidasAt: null };
    if (zajunaUser && zajunaUser.trim()) data.zajunaUserEnc = encrypt(zajunaUser.trim());

    await prisma.user.update({ where: { id: req.user.id }, data });

    // Invalida la sesión cacheada → el siguiente worker hará login fresco con la
    // clave nueva (si no, reusaría cookies viejas y no probaría la clave nueva).
    await saveSession(req.user.id, null).catch(() => {});

    return reply.code(200).send({ ok: true });
  });

  // ── GET /api/competencias ────────────────────────────────────────────────────
  // Catálogo de competencias sembradas. Abierto a CUALQUIER instructor autenticado:
  // es solo el catálogo (código + nombre, sin PII de otros usuarios) y lo necesita el
  // selector "Mi competencia" de Ajustes (plan 008 #1) además del simulador del admin.
  fastify.get("/api/competencias", { preHandler: fastify.authenticate }, async (req) => {
    const competencias = await prisma.competencia.findMany({ orderBy: { codigo: "asc" } });
    return competencias;
  });

  // ── POST /api/ajustes/mi-competencia ─────────────────────────────────────────
  // Cualquier instructor autenticado fija SU PROPIA competencia (vía req.user.id, no
  // por parámetro → no puede tocar la de otro: multi-tenant, regla #1). Reemplaza al
  // viejo flujo de pedirla en el registro (plan 008 #1). Re-firma el JWT con la
  // competencia nueva INCLUYENDO `rol` (a diferencia de simular-competencia, que omite
  // el claim de rol — no copiamos ese hueco aquí).
  fastify.post("/api/ajustes/mi-competencia", {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: "object",
        required: ["competenciaCodigo"],
        properties: { competenciaCodigo: { type: "string", minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    const { competenciaCodigo } = req.body;
    const competencia = await prisma.competencia.findUnique({ where: { codigo: competenciaCodigo } });
    if (!competencia) return reply.code(404).send({ error: "Competencia no encontrada." });

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { competenciaCodigo, competenciaNombre: competencia.nombre, competenciaId: competencia.id },
    });

    const token = fastify.jwt.sign(
      { id: req.user.id, email: req.user.email, nombre: req.user.nombre, rol: req.user.rol, competenciaCodigo, competenciaNombre: competencia.nombre },
      { expiresIn: "7d" },
    );

    return { token, competenciaCodigo, competenciaNombre: competencia.nombre };
  });

  // ═══ SUPERADMIN: Simulador de Competencias ════════════════════════════════
  // Los endpoints siguientes (descubrir-competencias y simular-competencia) están
  // estrictamente restringidos a SUPERADMIN.

  // ── POST /api/ajustes/descubrir-competencias ─────────────────────────────────
  // Encola un job que escanea las evidencias en DB y extrae códigos de competencia.
  fastify.post("/api/ajustes/descubrir-competencias", { preHandler: fastify.authenticate }, async (req, reply) => {
    if (!esSuperadmin(req.user)) return reply.code(403).send({ error: "Acceso restringido." });

    const job = await prisma.job.create({
      data: { userId: req.user.id, tipo: "descubrirCompetencias", status: "queued", progreso: 0 },
    });

    await descubrirCompetenciasQueue.add("descubrir", { jobId: job.id, userId: req.user.id });

    return reply.code(202).send({ jobId: job.id });
  });

  // ── POST /api/ajustes/simular-competencia ────────────────────────────────────
  // Cambia la competencia activa del superadmin y retorna un nuevo JWT firmado.
  fastify.post("/api/ajustes/simular-competencia", {
    preHandler: fastify.authenticate,
    schema: {
      body: {
        type: "object",
        required: ["competenciaCodigo"],
        properties: { competenciaCodigo: { type: "string", minLength: 1 } },
      },
    },
  }, async (req, reply) => {
    if (!esSuperadmin(req.user)) return reply.code(403).send({ error: "Acceso restringido." });

    const { competenciaCodigo } = req.body;
    const competencia = await prisma.competencia.findUnique({ where: { codigo: competenciaCodigo } });
    if (!competencia) return reply.code(404).send({ error: "Competencia no encontrada en DB." });

    await prisma.user.update({
      where: { id: req.user.id },
      data:  { competenciaCodigo, competenciaNombre: competencia.nombre, competenciaId: competencia.id },
    });

    const token = fastify.jwt.sign(
      { id: req.user.id, email: req.user.email, nombre: req.user.nombre, competenciaCodigo, competenciaNombre: competencia.nombre },
      { expiresIn: "7d" },
    );

    return { token, competenciaCodigo, competenciaNombre: competencia.nombre };
  });
}

module.exports = ajustesRoutes;
