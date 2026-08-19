'use strict';

const { Worker } = require('bullmq');
const { connection, JOB_RETENTION } = require('./queue');
const db = require('../config/db');
const crawler = require('../services/siteCrawler/crawler');
const {
  WORKER_ID,
  claimSiteCrawlerTask,
  finishSiteCrawlerTask,
  publishPendingOutbox,
} = require('../services/tasks/reliability');

const MAX_ATTEMPTS = Math.max(1, Number(process.env.SITE_CRAWL_MAX_ATTEMPTS) || 3);

async function processCrawl(job) {
  const { taskId, startUrl, options } = job.data || {};
  if (!taskId || !startUrl) throw new Error('invalid_site_crawl_job_payload');
  const claimed = await claimSiteCrawlerTask(taskId, WORKER_ID, db);
  if (!claimed) return { skipped: true, reason: 'crawl_not_claimable' };
  const { row, token } = claimed;
  try {
    const result = await crawler.runCrawl({
      taskId,
      startUrl: row.start_url || startUrl,
      options: {
        ...(row.options || options || {}),
        checkpoint: row.checkpoint || null,
        previousStats: row.stats || {},
      },
      leaseToken: token,
      workerId: WORKER_ID,
    }, db);
    return result;
  } catch (error) {
    const stats = row.stats || {};
    if (Number(row.attempts || 1) < MAX_ATTEMPTS) {
      const delaySeconds = Math.min(300, 5 * Math.pow(2, Number(row.attempts || 1) - 1));
      await db.query(
        `UPDATE site_crawl_tasks
            SET status='queued', error=$2, last_error_code='temporary_crawl_error',
                lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(), updated_at=NOW()
          WHERE id=$1 AND lease_token=$3::uuid`,
        [taskId, String(error.message || error).slice(0, 500), token],
      );
      await db.query(
        `INSERT INTO generator_task_outbox (queue_name,job_name,job_id,payload,available_at)
         VALUES ('site-crawls','crawl-site',$1,$2::jsonb,NOW()+make_interval(secs => $3))
         ON CONFLICT (queue_name,job_id) DO NOTHING`,
        [`site-crawl:${taskId}:retry:${row.attempts}`, JSON.stringify({ taskId, startUrl: row.start_url, options: row.options || {} }), delaySeconds],
      );
      await publishPendingOutbox(db, 50).catch(() => {});
      return { taskId, retry: true, delaySeconds };
    }
    await finishSiteCrawlerTask(taskId, token, 'error', stats, error, db).catch((persistError) => {
      console.error(`[SiteCrawlerWorker] failed to persist error for ${taskId}:`, persistError.message);
    });
    throw error;
  }
}

function createSiteCrawlerWorker() {
  const worker = new Worker('site-crawls', processCrawl, {
    connection,
    concurrency: Math.max(1, Number(process.env.SITE_CRAWL_WORKER_CONCURRENCY) || 2),
    stalledInterval: 30000,
    maxStalledCount: 2,
    lockDuration: 90000,
    removeOnComplete: JOB_RETENTION.completed,
    removeOnFail: JOB_RETENTION.failed,
  });
  worker.on('completed', (job) => console.log(`[SiteCrawlerWorker] job ${job.id} completed`));
  worker.on('failed', (job, error) => console.error(`[SiteCrawlerWorker] job ${job?.id} failed:`, error.message));
  worker.on('stalled', (jobId) => console.warn(`[SiteCrawlerWorker] job ${jobId} stalled; BullMQ will redeliver`));
  worker.on('error', (error) => console.error('[SiteCrawlerWorker] worker error:', error.message));
  return worker;
}

module.exports = { createSiteCrawlerWorker, processCrawl };
