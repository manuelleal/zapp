/**
 * api/src/routes/auth.js — Registro e inicio de sesión de instructores.
 *
 * Rutas:
 *   POST /api/auth/register — crear cuenta (nombre, email, password, credenciales Zajuna).
 *                              Las credenciales Moodle se cifran con AES-256-GCM
 *                              (lib/crypto.js) antes de persistir.
 *   POST /api/auth/login    — autenticar y devolver JWT (7d de vida).
 *
 * Rate limiting: Map en memoria (no Redis), max RATE_MAX intentos / 15 min por IP.
 * Razón de ser in-memory: suficiente para el MVP; migrar a Redis es P1 (§11.3 #8).
 * LIMITACIÓN: no sobrevive reinicios ni se comparte si hubiera múltiples procesos API
 * (hoy solo hay 1 instancia PM2).
 *
 * Competencia: YA NO se pide en el registro (las competencias cambian por guía y el
 * instructor no sabe cuál es la suya al registrarse — plan 008 #1). La elige luego en
 * Ajustes → "Mi competencia" (POST /api/ajustes/mi-competencia). Si el front igual
 * manda un código (compatibilidad), se vincula la FK competenciaId por código; si no
 * llega, queda "" / null y `lib/competencia.js` lo trata como "sin competencia".
 *
 * Consentimiento (Ley 1581): si el front manda `aceptoTerminos === true` (casilla
 * obligatoria del formulario de registro), se sella `aceptoTerminosAt` desde el signup
 * para que el WelcomeModal post-login NO se le repita al usuario nuevo.
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

    const { nombre, email, password, zajunaUser, zajunaPass, competenciaCodigo, competenciaNombre, aceptoTerminos } = req.body || {};

    // La competencia ya NO es obligatoria en el registro (se elige en Ajustes, plan 008 #1).
    if (!nombre || !email || !password || !zajunaUser || !zajunaPass) {
      return reply.code(400).send({ error: "Faltan campos obligatorios." });
    }

    const existe = await prisma.user.findUnique({ where: { email } });
    if (existe) return reply.code(409).send({ error: "El email ya está registrado." });

    const passwordHash   = await bcrypt.hash(password, 13);
    const zajunaUserEnc  = encrypt(zajunaUser);
    const zajunaPassEnc  = encrypt(zajunaPass);

    // Vincular la FK competenciaId SOLO si el front mandó un código y esa competencia
    // ya existe en DB. Lo normal ahora es que NO llegue código (se elige en Ajustes,
    // plan 008 #1) → competencia = null y los campos quedan vacíos. `lib/competencia.js`
    // trata competenciaCodigo "" como "sin competencia" (las páginas de RAPs/Actas
    // avisan que falta elegirla, no crashean).
    const competencia = competenciaCodigo
      ? await prisma.competencia.findUnique({ where: { codigo: competenciaCodigo } })
      : null;

    // Registro CERRADO: las cuentas nuevas quedan PENDIENTES de aprobación del
    // superadmin (aprobadoAt = null por defecto). Excepción: si el correo es el del
    // dueño (SUPERADMIN_EMAIL), se aprueba y se promueve a superadmin de una.
    const esDueno = esSuperadmin({ email });

    const user = await prisma.user.create({
      data: {
        nombre, email, passwordHash, zajunaUserEnc, zajunaPassEnc,
        // competenciaCodigo/Nombre son String NOT NULL en el schema → "" (no null) si no vino.
        competenciaCodigo: competenciaCodigo || "",
        competenciaNombre: competenciaNombre || competencia?.nombre || "",
        competenciaId:     competencia?.id ?? null,
        // Consentimiento registrado desde el signup si marcó la casilla obligatoria
        // (Ley 1581). Así el WelcomeModal post-login no se le repite. Si no llegó,
        // queda null y el modal aparece en el primer ingreso (comportamiento previo).
        aceptoTerminosAt:  aceptoTerminos === true ? new Date() : null,
        ...(esDueno ? { aprobadoAt: new Date(), rol: "superadmin" } : {}),
      },
    });

    // No se inicia sesión automáticamente si la cuenta quedó pendiente: el instructor
    // debe esperar a que el administrador la apruebe en el panel.
    if (!user.aprobadoAt) {
      return reply.code(201).send({
        pendiente: true,
        message: "Tu cuenta fue creada y está pendiente de aprobación por el administrador. Te avisaremos cuando puedas ingresar.",
      });
    }

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

    // Registro CERRADO: la cuenta debe estar aprobada por el administrador. El dueño
    // (superadmin / SUPERADMIN_EMAIL) entra siempre, sin necesidad de aprobación.
    if (!user.aprobadoAt && !esSuperadmin(user)) {
      return reply.code(403).send({ error: "Tu cuenta está pendiente de aprobación por el administrador. Te avisaremos cuando puedas ingresar." });
    }

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
