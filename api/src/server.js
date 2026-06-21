/**
 * api/src/server.js — Servidor HTTP Fastify (solo API + estáticos).
 *
 * IMPORTANTE: este proceso NO carga los workers BullMQ. Los workers corren en un
 * proceso separado (`api/src/worker-entry.js`, app "workers" en ecosystem.config.js).
 * Esta separación es crítica: un OOM de un scraper Playwright no derriba la API.
 * Ver CLAUDE.md §11.1 y §11.3 P0 #1 para el razonamiento completo.
 *
 * Plugins registrados:
 *   - @fastify/cors      → ALLOWED_ORIGIN (.env) o localhost:5173 (dev)
 *   - @fastify/jwt       → JWT_SECRET (.env); token expira en 7d
 *   - @fastify/multipart → subida de archivos (PDF de guías, CSV de actas); límite 15MB
 *   - @fastify/static    → sirve web/dist/ (build de React/Vite)
 *   - SPA fallback       → cualquier GET no-API sin match devuelve index.html
 *
 * Headers de seguridad inyectados en onSend (todos los responses):
 *   X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy.
 *
 * Monitoreo de errores: Sentry (opcional). Si SENTRY_DSN no está en .env, se
 *   deshabilita silenciosamente — no rompe nada en dev local sin cuenta de Sentry.
 *
 * Puerto: 3000 (configurable en el future con PORT env).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

// ─── SENTRY (inicializar ANTES de todo lo demás) ──────────────────────────────
// Si SENTRY_DSN no está definido, Sentry queda deshabilitado sin error.
// Para habilitarlo: crear proyecto en sentry.io → copiar el DSN en .env.
const Sentry = require("@sentry/node");
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn:         process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || "production",
    // Captura el 10% de transacciones para performance (ajustar en producción).
    tracesSampleRate: 0.1,
  });
}

const path    = require("path");
const fastify = require("fastify")({
  logger: {
    level: "info",
    serializers: {
      req(req) { return { method: req.method, url: req.url, hostname: req.hostname }; },
    },
  },
});

// ─── PLUGINS ─────────────────────────────────────────────────────────────────

fastify.register(require("@fastify/cors"), {
  origin: process.env.ALLOWED_ORIGIN || "http://localhost:5173",
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
});

fastify.register(require("@fastify/jwt"), { secret: process.env.JWT_SECRET });

// Subida de archivos (PDF de guías para extraer RAPs con IA; CSV de actas).
// Límite 15MB: una guía de aprendizaje en PDF rara vez pesa más. Sin esto,
// `req.file()` / `req.parts()` no existen y las rutas multipart fallan en runtime.
fastify.register(require("@fastify/multipart"), {
  limits: { fileSize: 15 * 1024 * 1024 },
});

fastify.register(require("@fastify/static"), {
  root:   path.join(__dirname, "../../web/dist"),
  prefix: "/",
});

// SPA fallback: cualquier GET no-API que no matchee un asset estatico
// devuelve index.html para que React Router maneje la ruta client-side.
// Usamos AMBOS mecanismos (setNotFoundHandler + ruta wildcard) porque @fastify/static
// a veces atrapa la solicitud antes del notFoundHandler.
fastify.setNotFoundHandler((req, reply) => {
  if (req.method !== "GET" || req.url.startsWith("/api/")) {
    return reply.code(404).send({ error: "Not Found" });
  }
  return reply.sendFile("index.html");
});

// ─── SECURITY HEADERS ────────────────────────────────────────────────────────

fastify.addHook("onSend", async (req, reply) => {
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});

// ─── AUTH HELPER ─────────────────────────────────────────────────────────────

fastify.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Token inválido o expirado." });
  }
});

// ─── ERROR HANDLER GLOBAL ────────────────────────────────────────────────────
// Evita filtrar al cliente stacks/mensajes internos (Prisma, etc.) en errores no
// controlados. Loguea el error completo del lado servidor; al cliente le devuelve
// el statusCode original si es un 4xx esperado, o un 500 genérico si no.
// Los 5xx se reportan a Sentry con el contexto del instructor (userId/email).
fastify.setErrorHandler((error, req, reply) => {
  const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 500
    ? error.statusCode
    : 500;
  if (status >= 500) {
    req.log.error({ err: error }, "Error no controlado");
    // Enviar a Sentry con contexto del usuario para saber qué instructor lo disparó.
    if (process.env.SENTRY_DSN) {
      Sentry.withScope((scope) => {
        if (req.user) scope.setUser({ id: req.user.id, email: req.user.email });
        scope.setExtra("url",    req.url);
        scope.setExtra("method", req.method);
        Sentry.captureException(error);
      });
    }
    return reply.code(500).send({ error: "Error interno del servidor." });
  }
  // 4xx de validación de Fastify u otros: el mensaje es seguro de mostrar.
  return reply.code(status).send({ error: error.message || "Solicitud inválida." });
});

// ─── HEALTH ──────────────────────────────────────────────────────────────────
// Ping rápido a Postgres y Redis. 200 si ambos responden, 503 si alguno falla.
// Útil para Docker healthcheck / k8s readiness / monitoreo externo.
const prisma = require("./db/client");
const { connection: redis } = require("./lib/queue");

fastify.get("/api/health", async (req, reply) => {
  const checks = { db: false, redis: false };
  try { await prisma.$queryRaw`SELECT 1`; checks.db = true; } catch { /* db down */ }
  try { checks.redis = (await redis.ping()) === "PONG"; } catch { /* redis down */ }

  const ok = checks.db && checks.redis;
  return reply.code(ok ? 200 : 503).send({
    status: ok ? "ok" : "degraded",
    ...checks,
    uptime: Math.round(process.uptime()),
  });
});

// ─── RUTAS ───────────────────────────────────────────────────────────────────

fastify.register(require("./routes/auth"));
fastify.register(require("./routes/fichas"));
fastify.register(require("./routes/jobs"));
fastify.register(require("./routes/evidencias"));
fastify.register(require("./routes/archivar"));
fastify.register(require("./routes/configEvidencias"));
fastify.register(require("./routes/batchConfig"));
fastify.register(require("./routes/foroRating"));
fastify.register(require("./routes/scan"));
fastify.register(require("./routes/raps"));
fastify.register(require("./routes/matchingIa"));
fastify.register(require("./routes/actas"));
fastify.register(require("./routes/actasImport"));
fastify.register(require("./routes/mensajes"));
fastify.register(require("./routes/ajustes"));
fastify.register(require("./routes/admin"));

// ─── WORKERS ─────────────────────────────────────────────────────────────────
// Los workers BullMQ ya NO viven aquí. Corren en un proceso separado
// (api/src/worker-entry.js, app "workers" en ecosystem.config.js) para que un
// OOM de scraper no tumbe la API. Ver CLAUDE.md §11.1 / §11.3 P0 #1.

// ─── START ───────────────────────────────────────────────────────────────────

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1); }
});
