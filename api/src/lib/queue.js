const { Queue } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const retryOpts = {
  attempts: 3,
  backoff: { type: "exponential", delay: 10_000 },
  removeOnComplete: 100,
  removeOnFail: 50,
};

const fichasQueue       = new Queue("fichas",     { connection, defaultJobOptions: retryOpts });
const evidenciasQueue   = new Queue("evidencias", { connection, defaultJobOptions: retryOpts });
const configQueue       = new Queue("config",     { connection, defaultJobOptions: { ...retryOpts, attempts: 2 } });
const leerConfigQueue   = new Queue("leerConfig",   { connection, defaultJobOptions: { ...retryOpts, attempts: 2 } });
// Lote: lee la config de TODAS las evidencias de una ficha en UNA sesión.
// attempts:1 — es idempotente por evidencia pero relanzar todo el lote es caro.
const leerConfigLoteQueue = new Queue("leerConfigLote", { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 10 } });
const cambiarFechaQueue  = new Queue("cambiarFecha",  { connection, defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20, attempts: 1 } });
const cambiarConfigQueue = new Queue("cambiarConfig", { connection, defaultJobOptions: { removeOnComplete: 50, removeOnFail: 20, attempts: 1 } });
// attempts:1 — calificar un foro hace POST a /rating/rate.php por cada post SIN
// chequear si ya estaba calificado. Con reintentos, un POST cuya respuesta se pierde
// haría que BullMQ recalifique (doble calificación). Hasta que el scraper salte el
// POST si el post ya tiene la nota deseada, mantener 1 intento (como cambiarFecha).
const foroRatingQueue    = new Queue("foroRating",    { connection, defaultJobOptions: { ...retryOpts, attempts: 1 } });
const foroDescubrirQueue = new Queue("foroDescubrir", { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 30, removeOnFail: 10 } });
const autoScanQueue     = new Queue("autoScan",   { connection, defaultJobOptions: { removeOnComplete: 20, removeOnFail: 10 } });
const matchingIaQueue   = new Queue("matchingIa",  { connection, defaultJobOptions: { attempts: 1,  removeOnComplete: 50 } });
// attempts:1 — una sola llamada IA por job; reintentar gastaría tokens sin garantía
// de mejor resultado (la propuesta es para que el instructor confirme, no definitiva).
const extraerRapsIaQueue = new Queue("extraerRapsIa", { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 20 } });
const mensajesQueue     = new Queue("mensajes",    { connection, defaultJobOptions: { attempts: 2,  removeOnComplete: 50, removeOnFail: 20 } });
const syncParticipantesQueue = new Queue("syncParticipantes", { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 10 } });
const emailMasivoQueue            = new Queue("emailMasivo",            { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 50, removeOnFail: 20 } });
const descubrirCompetenciasQueue  = new Queue("descubrirCompetencias",  { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 10 } });
// Tick de mensajes programados: attempts:1 — si una corrida falla, el siguiente
// tick (10 min) la retoma; un retry inmediato podría duplicar envíos.
const mensajesProgramadosQueue    = new Queue("mensajesProgramados",    { connection, defaultJobOptions: { attempts: 1, removeOnComplete: 20, removeOnFail: 10 } });

// Repeatable global cada 3 horas. Idempotente: BullMQ deduplica por nombre+pattern.
autoScanQueue.add("auto-scan-all", {}, {
  repeat: { pattern: "0 */3 * * *" },
}).then(() => console.log("[autoScan] repeatable job registered (cada 3h)"))
  .catch(e => console.error("[autoScan] no se pudo registrar repeatable job:", e.message));

// Tick cada 10 min: el worker busca MensajeProgramado vencidos y los dispara.
// Un solo repeatable para TODOS los programados (no un repeatable por fila —
// así no hay que sincronizar claves de BullMQ con cada create/update/delete).
mensajesProgramadosQueue.add("tick", {}, {
  repeat: { pattern: "*/10 * * * *" },
}).then(() => console.log("[mensajesProgramados] repeatable tick registered (cada 10 min)"))
  .catch(e => console.error("[mensajesProgramados] no se pudo registrar repeatable tick:", e.message));

module.exports = { fichasQueue, evidenciasQueue, configQueue, leerConfigQueue, leerConfigLoteQueue, cambiarFechaQueue, cambiarConfigQueue, foroRatingQueue, foroDescubrirQueue, autoScanQueue, matchingIaQueue, extraerRapsIaQueue, mensajesQueue, syncParticipantesQueue, emailMasivoQueue, descubrirCompetenciasQueue, mensajesProgramadosQueue, connection };
