const bcrypt = require("bcrypt");
const prisma = require("../db/client");
const { encrypt } = require("../lib/crypto");

// ─── RATE LIMITER EN MEMORIA (login/register) ─────────────────────────────────
// Máximo 5 intentos por IP en 15 minutos
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX       = 500;
const rateLimitMap   = new Map(); // ip → { count, resetAt }

function checkRateLimit(ip) {
  const now  = Date.now();
  const entry = rateLimitMap.get(ip);

  if (entry) {
    if (now < entry.resetAt) {
      if (entry.count >= RATE_MAX) return false; // bloqueado
      entry.count++;
    } else {
      // ventana expirada → reiniciar
      rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    }
  } else {
    rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
  }
  return true;
}

async function authRoutes(fastify) {
  fastify.post("/api/auth/register", async (req, reply) => {
    if (!checkRateLimit(req.ip)) {
      return reply.code(429).send({ error: "Demasiados intentos. Espera 15 minutos." });
    }

    const { nombre, email, password, zajunaUser, zajunaPass, competenciaCodigo, competenciaNombre } = req.body || {};

    if (!nombre || !email || !password || !zajunaUser || !zajunaPass || !competenciaCodigo) {
      return reply.code(400).send({ error: "Faltan campos obligatorios." });
    }

    const existe = await prisma.user.findUnique({ where: { email } });
    if (existe) return reply.code(409).send({ error: "El email ya está registrado." });

    const passwordHash   = await bcrypt.hash(password, 13);
    const zajunaUserEnc  = encrypt(zajunaUser);
    const zajunaPassEnc  = encrypt(zajunaPass);

    const user = await prisma.user.create({
      data: { nombre, email, passwordHash, zajunaUserEnc, zajunaPassEnc, competenciaCodigo, competenciaNombre: competenciaNombre || "" },
    });

    const token = fastify.jwt.sign({ id: user.id, email: user.email, nombre: user.nombre }, { expiresIn: "7d" });
    return { token, user: { id: user.id, email: user.email, nombre: user.nombre, competenciaNombre: user.competenciaNombre } };
  });

  fastify.post("/api/auth/login", async (req, reply) => {
    if (!checkRateLimit(req.ip)) {
      return reply.code(429).send({ error: "Demasiados intentos. Espera 15 minutos." });
    }

    const { email, password } = req.body || {};
    if (!email || !password) return reply.code(400).send({ error: "Email y contraseña requeridos." });

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: "Credenciales inválidas." });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return reply.code(401).send({ error: "Credenciales inválidas." });

    const token = fastify.jwt.sign({ id: user.id, email: user.email, nombre: user.nombre }, { expiresIn: "7d" });
    return { token, user: { id: user.id, email: user.email, nombre: user.nombre, competenciaNombre: user.competenciaNombre } };
  });
}

module.exports = authRoutes;
