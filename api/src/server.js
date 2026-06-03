require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });

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

// ─── WORKERS ─────────────────────────────────────────────────────────────────
// Los workers BullMQ ya NO viven aquí. Corren en un proceso separado
// (api/src/worker-entry.js, app "workers" en ecosystem.config.js) para que un
// OOM de scraper no tumbe la API. Ver CLAUDE.md §11.1 / §11.3 P0 #1.

// ─── START ───────────────────────────────────────────────────────────────────

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1); }
});
