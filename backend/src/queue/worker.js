const { Worker } = require('bullmq');
const Redis = require('ioredis');
const db = require('../config/db');
const orchestrator = require('../services/pipeline/orchestrator');
const sseManager = require('../services/sse/sseManager');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const concurrency = parseInt(process.env.WORKER_CONCURRENCY, 10) || 2;

const worker = new Worker(
  'seo-pipeline',
  async (job) => {
    const { taskId } = job.data;
    const log = (message, data = {}) => {
      const payload = { type: 'log', message, ...data, timestamp: new Date().toISOString() };
      sseManager.publish(taskId, payload);
    };

    try {
      await db.query("UPDATE tasks SET status = 'running', started_at = NOW() WHERE id = $1", [taskId]);
      log('Pipeline started');

      await orchestrator.runPipeline(taskId, log);

      await db.query("UPDATE tasks SET status = 'completed', completed_at = NOW() WHERE id = $1", [taskId]);
      log('Pipeline completed');
      sseManager.publish(taskId, { type: 'done' });
    } catch (err) {
      console.error(`[worker] Pipeline failed for task ${taskId}:`, err.message);
      await db.query("UPDATE tasks SET status = 'failed', error = $2 WHERE id = $1", [taskId, err.message]);
      log(`Pipeline failed: ${err.message}`);
      sseManager.publish(taskId, { type: 'error', error: err.message });
      throw err;
    }
  },
  { connection, concurrency }
);

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

worker.on('completed', (job) => {
  console.log(`[worker] Job ${job.id} completed`);
});

module.exports = worker;
