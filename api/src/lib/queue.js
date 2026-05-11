const { Queue, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");

const connection = new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });

const fichasQueue       = new Queue("fichas",     { connection });
const fichasQueueEvents = new QueueEvents("fichas", { connection });
const evidenciasQueue   = new Queue("evidencias", { connection });
const configQueue       = new Queue("config",     { connection });
const foroRatingQueue   = new Queue("foroRating", { connection });

module.exports = { fichasQueue, fichasQueueEvents, evidenciasQueue, configQueue, foroRatingQueue, connection };
