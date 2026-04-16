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

const generationQueue = new Queue('content-generation', {
  connection,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 5000 },
    removeOnComplete: { age: 7  * 24 * 3600 },  // 7 дней
    removeOnFail:     { age: 14 * 24 * 3600 },  // 14 дней
  },
});

generationQueue.on('error', (err) => {
  console.error('[Queue] BullMQ error:', err.message);
});

module.exports = { generationQueue, connection };
