'use strict';

const axios = require('axios');
const { Worker } = require('bullmq');
const db = require('../config/db');
const { connection, JOB_RETENTION } = require('./queue');
const { getIntegrationSecret } = require('../services/integrations/integrationVault');
const { makeBullJobId } = require('./jobIds');
const { WORKER_ID, claimParserItem, retryParserItem, finishParserItem, publishPendingOutbox } = require('../services/tasks/reliability');
const {
  insertSearchItems,
  updateTaskProgress,
  finalizeParserTask,
  failParserTask,
} = require('../services/parser/parserTaskService');

const AUDIT_URL = (process.env.AUDIT_INTERNAL_URL || 'http://audit:8002').replace(/\/$/, '');
// Token is resolved dynamically from the central vault with env fallback.
const ITEM_MAX_ATTEMPTS = Math.max(1, Number(process.env.PARSER_ITEM_MAX_ATTEMPTS) || 3);
const RETRY_BASE_MS = Math.max(1000, Number(process.env.PARSER_RETRY_BASE_MS) || 5000);

async function auditHeaders() {
  const token = await getIntegrationSecret('RELEVANCE_INTERNAL_TOKEN');
  return token ? { 'X-Internal-Token': token } : {};
}

async function setParentRunning(taskId) {
  await db.query(
    `UPDATE parser_tasks
        SET status=CASE WHEN status='queued' THEN 'running' ELSE status END,
            heartbeat_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND status IN ('queued','running')`, [taskId],
  );
}

async function loadTaskOptions(taskId) {
  const { rows } = await db.query(`SELECT options FROM parser_tasks WHERE id=$1`, [taskId]);
  if (!rows.length) throw new Error('parser_task_not_found');
  return rows[0].options || {};
}

async function retryOrFail(item, token, error) {
  const attempts = Number(item.attempts) || 1;
  if (attempts < ITEM_MAX_ATTEMPTS) {
    const delay = Math.min(60000, RETRY_BASE_MS * Math.pow(2, attempts - 1));
    const released = await retryParserItem(item.id, token, error, delay, db);
    if (released) {
      const jobId = makeBullJobId('parser', released.task_id, item.id, 'retry', attempts);
      await db.query(
        `INSERT INTO generator_task_outbox (queue_name,job_name,job_id,payload,available_at)
         VALUES ('parser-scans','parse-url',$1,$2::jsonb,NOW()+make_interval(secs => $3))
         ON CONFLICT (queue_name,job_id) DO NOTHING`,
        [jobId, JSON.stringify({ taskId: released.task_id, itemId: item.id }), Math.ceil(delay / 1000)],
      );
      await publishPendingOutbox(db, 50).catch(() => {});
      return 'retry_wait';
    }
  }
  await finishParserItem(item.id, token, {
    url: item.normalized_url,
    status: 'Ошибка обработки сайта',
    error: error.message,
  }, 'failed', error, db);
  return 'failed';
}

async function processParseUrl(job) {
  const { taskId, itemId } = job.data || {};
  if (!taskId || !itemId) throw new Error('invalid_parser_job_payload');
  const claimed = await claimParserItem(itemId, WORKER_ID, db);
  if (!claimed) return { skipped: true, reason: 'item_not_claimable' };
  const { row: item, token } = claimed;
  await setParentRunning(taskId);

  try {
    const options = await loadTaskOptions(taskId);
    const payload = {
      urls: [item.normalized_url],
      extract_contacts: options.contacts !== false,
      extract_about: options.about !== false,
      extract_services: options.services !== false,
      extract_clients: options.clients !== false,
      api_key: (await getIntegrationSecret('DEEPSEEK_API_KEY')) || options.deepseek_api_key || '',
    };
    const response = await axios.post(`${AUDIT_URL}/audit/parsers/extract`, payload, {
      headers: { 'Content-Type': 'application/json', ...(await auditHeaders()) },
      timeout: Math.min(300000, Number(options.site_timeout_ms) || 300000),
      maxContentLength: 256 * 1024 * 1024,
    });
    const result = response.data?.results?.[0] || {
      url: item.normalized_url,
      status: 'Ошибка: пустой ответ от audit-сервиса',
    };
    const status = result.status && result.status !== 'Успешно' ? 'partial' : 'completed';
    await finishParserItem(item.id, token, result, status, null, db);
  } catch (error) {
    await retryOrFail(item, token, error);
  }

  const progress = await updateTaskProgress(taskId, db);
  if (progress.pending === 0 && progress.total > 0) {
    await finalizeParserTask(taskId, db);
  }
  return { taskId, itemId, processed: progress.processed, total: progress.total };
}

async function processSearchDispatch(job) {
  const { taskId } = job.data || {};
  if (!taskId) throw new Error('invalid_parser_dispatch_payload');
  await setParentRunning(taskId);
  const options = await loadTaskOptions(taskId);
  if (!options.search_query) throw new Error('search_query_missing');
  const { fetchYandexSerp } = require('../services/metaTags/xmlstockClient');
  try {
    const serp = await fetchYandexSerp({ query: options.search_query, page: 0 });
    const urls = (serp.organic || []).map((row) => row.url).filter(Boolean).slice(0, 10);
    if (!urls.length) {
      await failParserTask(taskId, new Error('Поисковая выдача не вернула URL'), db);
      return { taskId, total: 0 };
    }
    const total = await insertSearchItems(taskId, urls, db);
    return { taskId, total };
  } catch (error) {
    await failParserTask(taskId, error, db);
    throw error;
  }
}

function createParserWorker() {
  const worker = new Worker('parser-scans', async (job) => {
    if (job.name === 'dispatch-search') return processSearchDispatch(job);
    if (job.name === 'parse-url') return processParseUrl(job);
    throw new Error(`unknown_parser_job:${job.name}`);
  }, {
    connection,
    concurrency: Math.max(1, Number(process.env.PARSER_WORKER_CONCURRENCY) || 3),
    stalledInterval: 30000,
    maxStalledCount: 2,
    lockDuration: 90000,
    removeOnComplete: JOB_RETENTION.completed,
    removeOnFail: JOB_RETENTION.failed,
  });

  worker.on('completed', (job) => console.log(`[ParserWorker] job ${job.id} completed`));
  worker.on('failed', (job, error) => console.error(`[ParserWorker] job ${job?.id} failed:`, error.message));
  worker.on('stalled', (jobId) => console.warn(`[ParserWorker] job ${jobId} stalled; BullMQ will redeliver`));
  worker.on('error', (error) => console.error('[ParserWorker] worker error:', error.message));
  return worker;
}

module.exports = { createParserWorker, processParseUrl, processSearchDispatch };
