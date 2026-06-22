/**
 * api/src/routes/auth.js — Registro e inicio de sesión de instructores.
 *
 * Rutas:
 *   POST /api/auth/register — crear cuenta (nombre, email, password, credenciales Zajuna,
 *                              competenciaCodigo). Las credenciales Moodle se cifran con
 *                              AES-256-GCM (lib/crypto.js) antes de persistir.
 *   POST /api/auth/login    — autenticar y devolver JWT (7d de vida).
 *
 * Rate limiting: Map en memoria (no Redis), max RATE_MAX intentos / 15 min por IP.
 * Razón de ser in-memory: suficiente para el MVP; migrar a Redis es P1 (§11.3 #8).
 * LIMITACIÓN: no sobrevive reinicios ni se comparte si hubiera múltiples procesos API
 * (hoy solo hay 1 instancia PM2).
 *
 * competenciaId: se vincula por código en el registro. Sin esto el matching IA
 * falla con "El usuario no tiene competencia asignada". Si la competencia aún no
 * existe en DB (instructor de programa nuevo) queda null y se asigna luego vía
 * descubrir-competencias o el extractor de guías.
 */
const bcrypt = require("bcrypt");
const prisma = require("../db/client");
const { encrypt } = require("../lib/crypto");
const { esSuperadmin } = require("../lib/roles");

// ─── RATE LIMITER EN MEMORIA (login/register) ─────────────────────────────────
// Máximo RATE_MAX intentos por IP dentro de la ventana (default 10 / 15 min).
// Configurable vía env RATE_MAX. Antes estaba hardcodeado en 500 (el comentario
// decía 5) — efectivamente sin límite real (CLAUDE.md §9.2 / §11.3 P0 #5).
// NOTA: el Map en memoria no sobrevive reinicios ni se comparte entre procesos;
// migrar a Redis es P1 (§11.3 #8).
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX       = Number(process.env.RATE_MAX) || 10;
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

    // Vincular la FK competenciaId si la competencia ya existe en DB (por código).
    // Sin esto, el Matching IA falla con "El usuario no tiene competencia asignada"
    // y había que asignarla a mano (le pasó al superadmin el 9-jun-2026). Si la
    // competencia aún no existe (instructor de un programa nuevo), queda null y se
    // vincula después vía descubrir-competencias / extractor de guías.
    const competencia = await prisma.competencia.findUnique({ where: { codigo: competenciaCodigo } });

    const user = await prisma.user.create({
      data: {
        nombre, email, passwordHash, zajunaUserEnc, zajunaPassEnc, competenciaCodigo,
        competenciaNombre: competenciaNombre || competencia?.nombre || "",
        competenciaId:     competencia?.id ?? null,
      },
    });

    const token = fastify.jwt.sign({ id: user.id, email: user.email, nombre: user.nombre, rol: user.rol }, { expiresIn: "7d" });
    return { token, user: { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol, competenciaNombre: user.competenciaNombre, aceptoTerminosAt: user.aceptoTerminosAt } };
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

    // Cuenta suspendida por el superadmin (soft-state): no puede iniciar sesión.
    if (user.suspendedAt) return reply.code(403).send({ error: "Tu cuenta está suspendida. Contacta al administrador." });

    // Registrar último acceso (lo usa el panel del superadmin para ver actividad).
    // Auto-sanado del dueño: si su correo es el SUPERADMIN_EMAIL pero el rol quedó en
    // "instructor" (p.ej. la DB de prod se recreó con el default), se corrige aquí para
    // que el panel /admin —que lee `rol` de la DB— lo reconozca sin intervención manual.
    const datosLogin = { lastLoginAt: new Date() };
    if (esSuperadmin(user) && user.rol !== "superadmin") {
      datosLogin.rol = "superadmin";
      user.rol = "superadmin"; // refleja el cambio en el token que se firma abajo
    }
    await prisma.user.update({ where: { id: user.id }, data: datosLogin });

    const token = fastify.jwt.sign({ id: user.id, email: user.email, nombre: user.nombre, rol: user.rol }, { expiresIn: "7d" });
    return { token, user: { id: user.id, email: user.email, nombre: user.nombre, rol: user.rol, competenciaNombre: user.competenciaNombre, aceptoTerminosAt: user.aceptoTerminosAt } };
  });

  // ── GET /api/auth/me ──────────────────────────────────────────────────────
  // Devuelve el usuario actual (para que el front decida nav de admin / modal de
  // bienvenida tras un reload, sin re-loguear). Lee de DB para reflejar rol/estado
  // actuales (un cambio de rol no requiere re-login).
  fastify.get("/api/auth/me", { preHandler: fastify.authenticate }, async (req, reply) => {
    const user = await prisma.user.findUnique({
      where:  { id: req.user.id },
      select: { id: true, email: true, nombre: true, rol: true, competenciaNombre: true, aceptoTerminosAt: true, suspendedAt: true },
    });
    if (!user) return reply.code(404).send({ error: "Usuario no encontrado." });
    if (user.suspendedAt) return reply.code(403).send({ error: "Cuenta suspendida." });
    return { user };
  });

  // ── POST /api/auth/aceptar-terminos ───────────────────────────────────────
  // Marca que el instructor aceptó el aviso de uso/tratamiento de datos (modal de
  // bienvenida). Idempotente: si ya aceptó, conserva la fecha original.
  fastify.post("/api/auth/aceptar-terminos", { preHandler: fastify.authenticate }, async (req, reply) => {
    const actual = await prisma.user.findUnique({ where: { id: req.user.id }, select: { aceptoTerminosAt: true } });
    if (actual && !actual.aceptoTerminosAt) {
      await prisma.user.update({ where: { id: req.user.id }, data: { aceptoTerminosAt: new Date() } });
    }
    return { ok: true };
  });
}

module.exports = authRoutes;
