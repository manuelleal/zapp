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
  origin: process.env.ALLOWED_ORIGIN || false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
});

fastify.register(require("@fastify/jwt"), { secret: process.env.JWT_SECRET });

fastify.register(require("@fastify/static"), {
  root:   path.join(__dirname, "../../web/dist"),
  prefix: "/",
});

// ─── AUTH HELPER ─────────────────────────────────────────────────────────────

fastify.decorate("authenticate", async (req, reply) => {
  try {
    await req.jwtVerify();
  } catch {
    reply.code(401).send({ error: "Token inválido o expirado." });
  }
});

// ─── RUTAS ───────────────────────────────────────────────────────────────────

fastify.register(require("./routes/auth"));
fastify.register(require("./routes/fichas"));
fastify.register(require("./routes/jobs"));
fastify.register(require("./routes/evidencias"));
fastify.register(require("./routes/archivar"));
fastify.register(require("./routes/configEvidencias"));

// ─── WORKER ──────────────────────────────────────────────────────────────────

require("./workers/fichasWorker");
require("./workers/evidenciasWorker");
require("./workers/configWorker");

// ─── START ───────────────────────────────────────────────────────────────────

fastify.listen({ port: 3000, host: "0.0.0.0" }, (err) => {
  if (err) { fastify.log.error(err); process.exit(1); }
});
