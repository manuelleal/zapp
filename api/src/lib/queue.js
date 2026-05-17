const { Queue, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const retryOpts = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 100,
  removeOnFail: 50,
};

const fichasQueue       = new Queue("fichas",     { connection, defaultJobOptions: retryOpts });
const fichasQueueEvents = new QueueEvents("fichas", { connection });
const evidenciasQueue   = new Queue("evidencias", { connection, defaultJobOptions: retryOpts });
const configQueue       = new Queue("config",     { connection, defaultJobOptions: { ...retryOpts, attempts: 2 } });
const leerConfigQueue   = new Queue("leerConfig",   { connection, defaultJobOptions: { ...retryOpts, attempts: 2 } });
const cambiarFechaQueue  = new Queue("cambiarFecha",  { connection, defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20, attempts: 1 } });
const cambiarConfigQueue = new Queue("cambiarConfig", { connection, defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20, attempts: 1 } });
const foroRatingQueue   = new Queue("foroRating",   { connection, defaultJobOptions: retryOpts });
const autoScanQueue     = new Queue("autoScan",   { connection, defaultJobOptions: { removeOnComplete: 20, removeOnFail: 10 } });
const matchingIaQueue   = new Queue("matchingIa", { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 50 } });

// Repeatable global cada 3 horas. Idempotente: BullMQ deduplica por nombre+pattern.
autoScanQueue.add("auto-scan-all", {}, {
  repeat: { pattern: "0 */3 * * *" },
}).then(() => console.log("[autoScan] repeatable job registered (cada 3h)"))
  .catch(e => console.error("[autoScan] no se pudo registrar repeatable job:", e.message));

module.exports = { fichasQueue, fichasQueueEvents, evidenciasQueue, configQueue, leerConfigQueue, cambiarFechaQueue, cambiarConfigQueue, foroRatingQueue, autoScanQueue, matchingIaQueue, connection };
