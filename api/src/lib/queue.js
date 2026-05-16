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
const foroRatingQueue   = new Queue("foroRating", { connection, defaultJobOptions: retryOpts });

module.exports = { fichasQueue, fichasQueueEvents, evidenciasQueue, configQueue, foroRatingQueue, connection };
