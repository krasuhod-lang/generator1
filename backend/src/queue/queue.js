const { Queue } = require('bullmq');

/**
 * Парсит REDIS_URL вида redis://:password@host:port.
 * Все очереди используют один и тот же безопасно нормализованный connection.
 */
function parseRedisConnection() {
  const url = process.env.REDIS_URL;
  if (url) {
    try {
      const u = new URL(url);
      return {
        host: u.hostname || 'localhost',
        port: parseInt(u.port, 10) || 6379,
        password: u.password || undefined,
      };
    } catch (e) {
      console.warn('[Queue] Не удалось распарсить REDIS_URL, используем fallback:', e.message);
    }
  }
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

const connection = parseRedisConnection();

const JOB_RETENTION = Object.freeze({
  completed: { age: 3 * 24 * 3600, count: 1000 },
  failed: { age: 7 * 24 * 3600, count: 500 },
});

const DEFAULT_JOB_OPTIONS = Object.freeze({
  attempts: 1,
  removeOnComplete: JOB_RETENTION.completed,
  removeOnFail: JOB_RETENTION.failed,
});

function makeQueue(name) {
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
  queue.on('error', (err) => {
    console.error(`[Queue:${name}] BullMQ error:`, err.message);
  });
  return queue;
}

const generationQueue = makeQueue('content-generation');
const parserQueue = makeQueue('parser-scans');
const siteCrawlerQueue = makeQueue('site-crawls');
const auditQueue = makeQueue('audit-jobs');
const projectAnalysisQueue = makeQueue('project-analysis');
const reportSummaryQueue = makeQueue('report-summary');

module.exports = {
  generationQueue,
  parserQueue,
  siteCrawlerQueue,
  auditQueue,
  projectAnalysisQueue,
  reportSummaryQueue,
  connection,
  JOB_RETENTION,
  DEFAULT_JOB_OPTIONS,
};
