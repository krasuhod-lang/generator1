'use strict';

const { Queue } = require('bullmq');

/**
 * Парсит REDIS_URL вида redis://:password@host:port
 * или redis://host:port в объект { host, port, password }
 * Если REDIS_URL не задан — падает обратно на REDIS_HOST/PORT.
 */
function parseRedisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host:     u.hostname || 'localhost',
        port:     parseInt(u.port)  || 6379,
        password: u.password        || undefined,
      };
    } catch (e) {
      console.warn('[Queue] Не удалось распарсить REDIS_URL, используем fallback:', e.message);
    }
  }
  return {
    host:     process.env.REDIS_HOST     || 'localhost',
    port:     parseInt(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

const connection = parseRedisConnection();

const JOB_RETENTION = Object.freeze({
  completed: { age: 3 * 24 * 3600, count: 1000 },
  failed:    { age: 7 * 24 * 3600, count: 500 },
});

const generationQueue = new Queue('content-generation', {
  connection,
  defaultJobOptions: {
    // Ретраи выполняются явно в воркере (checkpoint-aware авто-возобновление),
    // поэтому внутренний ретрай BullMQ отключён (attempts: 1), чтобы не
    // дублировать перезапуски.
    attempts: 1,
    removeOnComplete: JOB_RETENTION.completed,
    removeOnFail:     JOB_RETENTION.failed,
  },
});

generationQueue.on('error', (err) => {
  console.error('[Queue] BullMQ error:', err.message);
});

module.exports = { generationQueue, connection, JOB_RETENTION };
