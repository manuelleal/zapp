const nodemailer = require("nodemailer");
const prisma = require("../db/client");
const { encrypt, decrypt } = require("../lib/crypto");

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
      const msg = err.message || "";
      // Microsoft deshabilita SMTP Auth básico a nivel de tenant (política corporativa).
      // Código de error: "SmtpClientAuthentication is disabled" / "535 5.7.139"
      if (msg.includes("SmtpClientAuthentication") || msg.includes("535 5.7.139")) {
        return reply.code(200).send({
          ok: false,
          error: "Tu cuenta de Outlook/SENA tiene autenticación SMTP deshabilitada por el administrador de Microsoft. Usa Gmail con contraseña de aplicación, o contacta a sistemas del SENA.",
        });
      }
      return reply.code(200).send({ ok: false, error: msg });
    }
  });

  // ── DELETE /api/ajustes/correo ──────────────────────────────────────────────
  fastify.delete("/api/ajustes/correo", { preHandler: fastify.authenticate }, async (req, reply) => {
    await prisma.configCorreo.deleteMany({ where: { userId: req.user.id } });
    return reply.code(200).send({ ok: true });
  });
}

module.exports = ajustesRoutes;
