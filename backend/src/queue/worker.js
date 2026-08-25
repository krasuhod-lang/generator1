'use strict';

const { Worker, DelayedError } = require('bullmq');
const crypto = require('crypto');
const os = require('os');
const { connection, JOB_RETENTION } = require('./queue');
const { generationQueue } = require('./queue');
const db             = require('../config/db');
const { ensureDurableTaskSchema } = require('../services/tasks/durableSchema');
const schemaReady = (async () => {
  let lastError;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await ensureDurableTaskSchema();
      return;
    } catch (error) {
      lastError = error;
      console.warn(`[Worker] reliability schema attempt ${attempt}/20 failed:`, error.message);
      await new Promise((resolve) => setTimeout(resolve, Math.min(15000, attempt * 1000)));
    }
  }
  throw lastError;
})();
const { publish }    = require('../services/sse/sseManager');

const { runPipeline, PipelinePausedError } = require('../services/pipeline/orchestrator');
const { createParserWorker } = require('./parserWorker');
const { createSiteCrawlerWorker } = require('./siteCrawlerWorker');
const {
  claimGenerationTask: claimGenerationTaskWithProfileSlot,
} = require('../services/tasks/generationAdmission');
const { acquireUserTaskSlot } = require('../services/tasks/userTaskAdmission');

// Максимум автоматических возобновлений задачи после ошибки пайплайна.
// Задача НЕ падает сразу в "failed": воркер сам переставляет её на возобновление
// с последнего checkpoint (без потери прогресса и без ручной перенастройки),
// и только исчерпав попытки — помечает "failed".
const PIPELINE_AUTO_RETRIES = Math.max(0, parseInt(process.env.PIPELINE_AUTO_RETRIES, 10) || 3);
const GENERATOR_LEASE_SECONDS = Math.max(30, Number(process.env.TASK_LEASE_SECONDS) || 60);
const GENERATOR_HEARTBEAT_MS = Math.max(5000, Number(process.env.TASK_HEARTBEAT_MS) || 15000);
const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;

// -----------------------------------------------------------------
// Вспомогательные функции
// -----------------------------------------------------------------

/**
 * Загружает задачу из БД по ID.
 * @param {string} taskId
 * @returns {Promise<object>}
 */
async function loadTask(taskId) {
  const { rows } = await db.query(
    `SELECT * FROM tasks WHERE id = $1`,
    [taskId]
  );
  if (!rows.length) throw new Error(`Task ${taskId} not found in DB`);
  return rows[0];
}


/**
 * Обновляет поля задачи в БД.
 * @param {string} taskId
 * @param {object} fields — { status, bull_job_id, started_at, completed_at, error_message, ... }
 */
async function updateTask(taskId, fields, expectedLeaseToken = null) {
  const keys = Object.keys(fields);
  const values = Object.values(fields);
  const setClause = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const params = [taskId, ...values];
  let where = 'id = $1';
  if (expectedLeaseToken) {
    params.push(expectedLeaseToken);
    where += ` AND lease_token = $${params.length}`;
  }
  const result = await db.query(
    `UPDATE tasks SET ${setClause}, updated_at = NOW() WHERE ${where}`,
    params,
  );
  if (expectedLeaseToken && result.rowCount !== 1) {
    throw new Error('generator_lease_lost');
  }
  return result;
}

/**
 * Публикует лог-событие в SSE-поток задачи.
 * @param {string} taskId
 * @param {string} msg
 * @param {'info'|'success'|'warn'|'error'|'system'} level
 */
function log(taskId, msg, level = 'info') {
  const ts = new Date().toTimeString().substring(0, 8);
  publish(taskId, { type: 'log', msg, level, ts });
  console.log(`[Worker][${taskId.substring(0, 8)}] [${level}] ${msg}`);
}

/**
 * Публикует событие прогресса в SSE-поток задачи.
 * @param {string} taskId
 * @param {number} percent   — 0–100
 * @param {string} stageName — 'stage0', 'stage1', ...
 */
function progress(taskId, percent, stageName) {
  publish(taskId, { type: 'progress', percent, stage: stageName });
}

// -----------------------------------------------------------------
// BullMQ Worker
// -----------------------------------------------------------------

const worker = new Worker(
  'content-generation',

  async (job) => {
    await schemaReady;
    const { taskId } = job.data;

    // ── 1. Загрузка задачи ────────────────────────────────────────
    const task = await loadTask(taskId);

    // ── 2. Атомарно claim-им общий user slot, task и профильный slot ──
    const leaseToken = crypto.randomUUID();
    const globalSlot = await acquireUserTaskSlot({
      userId: task.user_id,
      taskType: 'generation',
      taskId,
      maxWaitMs: 1000,
    });
    if (!globalSlot.claimed) {
      const delayMs = Math.min(30000, 5000 + Number(globalSlot.activeCount || 0) * 1000);
      try {
        await job.moveToDelayed(Date.now() + delayMs, job.token);
        throw new DelayedError();
      } catch (error) {
        if (error instanceof DelayedError) throw error;
        throw Object.assign(new Error('user_task_slot_unavailable'), {
          code: 'user_task_slot_unavailable',
        });
      }
    }
    let claim;
    try {
      claim = await claimGenerationTaskWithProfileSlot({
        taskId,
        jobId: job.id,
        leaseToken,
        workerId: WORKER_ID,
        leaseSeconds: GENERATOR_LEASE_SECONDS,
      });
    } catch (error) {
      await globalSlot.release().catch(() => {});
      throw error;
    }
    if (!claim.claimed) {
      await globalSlot.release().catch(() => {});
      if (claim.reason === 'profile_limit') {
        // Не превращаем нормальное ожидание свободного slot в failed. BullMQ
        // вернет тот же job в delayed, после чего он снова будет проверен.
        const delayMs = Math.min(30000, 5000 + claim.activeCount * 1000);
        try {
          await job.moveToDelayed(Date.now() + delayMs, job.token);
          throw new DelayedError();
        } catch (error) {
          if (error instanceof DelayedError) throw error;
          console.warn(`[Worker] profile slot defer failed for ${taskId}:`, error.message);
          throw Object.assign(new Error('profile_slot_unavailable'), {
            code: 'profile_slot_unavailable',
          });
        }
      }
      console.log(`[Worker] skip job ${job.id}: task ${taskId} is owned by another worker or terminal`);
      return { skipped: true, reason: 'generation_lease_not_acquired' };
    }

    const heartbeatTimer = setInterval(() => {
      updateTask(taskId, {
        heartbeat_at: new Date(),
        lease_until: new Date(Date.now() + GENERATOR_LEASE_SECONDS * 1000),
      }, leaseToken).catch((e) => console.warn(`[Worker][${taskId.substring(0, 8)}] heartbeat failed:`, e.message));
    }, GENERATOR_HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    log(taskId, `Задача "${task.input_target_service}" запущена в работу`, 'info');
    progress(taskId, 0, 'stage0');

    try {
      // ── 3. Пайплайн Stage 0 → Stage 7 ────────────────────────────
      await runPipeline(task, {
        log:        (msg, level) => log(taskId, msg, level),
        progress:   (pct, stage) => progress(taskId, pct, stage),
        job,
        resumeFrom: job.data.resumeFrom || null,
      });

      // ── 4. Завершение ─────────────────────────────────────────────
      await updateTask(taskId, {
        status: 'completed',
        completed_at: new Date(),
        heartbeat_at: new Date(),
        lease_token: null,
        lease_until: null,
      }, leaseToken);

      clearInterval(heartbeatTimer);
      progress(taskId, 100, 'done');
      log(taskId, 'Задача успешно завершена', 'success');

      publish(taskId, {
        type:    'done',
        taskId,
        message: 'Pipeline completed',
      });

    } catch (pipelineErr) {
      // ── 5a. Graceful pause (кнопка "Стоп") ───────────────────────
      if (pipelineErr instanceof PipelinePausedError) {
        clearInterval(heartbeatTimer);
        await updateTask(taskId, {
          status: 'paused',
          pipeline_checkpoint: JSON.stringify(pipelineErr.checkpoint || {}),
          heartbeat_at: new Date(),
          lease_token: null,
          lease_until: null,
        }, leaseToken);

        log(taskId, 'Задача приостановлена пользователем', 'info');

        publish(taskId, {
          type:        'paused',
          blocksDone:  pipelineErr.checkpoint?.resumeFromBlock ?? 0,
          blocksTotal: pipelineErr.checkpoint?.taxonomy?.length ?? 0,
        });

        // Не пробрасываем — BullMQ НЕ должен считать это как failed
        return;
      }

      // ── 5b. Обработка ошибки пайплайна ───────────────────────────
      const errMsg = pipelineErr.message || String(pipelineErr);

      // ── 5b-i. Авто-возобновление ─────────────────────────────────
      // Не роняем задачу сразу: пытаемся автоматически продолжить с последнего
      // checkpoint (orchestrator сохраняет его перед каждым блоком). Так задача
      // не требует ручной перенастройки и перезапуска после разовых сбоев
      // (таймауты LLM, сетевые ошибки и т.п.).
      const autoRetries = job.data.autoRetries || 0;
      if (autoRetries < PIPELINE_AUTO_RETRIES) {
        const attempt = autoRetries + 1;
        try {
          // Свежий checkpoint (может быть обновлён во время выполнения)
          const fresh = await loadTask(taskId);
          const checkpoint = fresh.pipeline_checkpoint || null;

          // Экспоненциальный backoff с потолком 60с
          const delay = Math.min(60000, 5000 * Math.pow(2, autoRetries));

          const retryJob = await generationQueue.add(
            'generate',
            { taskId, resumeFrom: checkpoint, autoRetries: attempt },
            { jobId: `${taskId}-autoretry-${Date.now()}`, attempts: 1, delay }
          );

          clearInterval(heartbeatTimer);
          await updateTask(taskId, {
            status: 'queued',
            bull_job_id: String(retryJob.id),
            error_message: null,
            heartbeat_at: new Date(),
            lease_token: null,
            lease_until: null,
          }, leaseToken);

          log(
            taskId,
            `Ошибка пайплайна: ${errMsg}. Авто-возобновление ${attempt}/${PIPELINE_AUTO_RETRIES} через ${Math.round(delay / 1000)}с...`,
            'warn'
          );

          publish(taskId, {
            type:    'retrying',
            attempt,
            maxAttempts: PIPELINE_AUTO_RETRIES,
            delay,
            msg:     errMsg,
          });

          // Не пробрасываем — эта job "обработана" (перепоставлена в очередь),
          // BullMQ не должен считать её failed.
          return;
        } catch (retryErr) {
          // Если не удалось поставить авто-возобновление — падаем в failed ниже.
          console.error(`[Worker][${taskId.substring(0, 8)}] Не удалось запланировать авто-возобновление:`, retryErr.message);
        }
      }

      // ── 5b-ii. Финальная ошибка (авто-попытки исчерпаны) ─────────
      clearInterval(heartbeatTimer);
      await updateTask(taskId, {
        status: 'failed',
        error_message: errMsg.substring(0, 1000),
        last_error_code: 'pipeline_error',
        completed_at: new Date(),
        heartbeat_at: new Date(),
        lease_token: null,
        lease_until: null,
      }, leaseToken);

      log(taskId, `Ошибка пайплайна: ${errMsg}`, 'error');

      publish(taskId, {
        type:  'error',
        stage: 'pipeline',
        msg:   errMsg,
      });

      // Пробрасываем, чтобы BullMQ записал job в failed
      throw pipelineErr;
    } finally {
      await globalSlot.release().catch((error) => {
        console.warn(`[Worker][${taskId.substring(0, 8)}] user slot release failed:`, error.message);
      });
    }
  },

  {
    connection,
    // Must be larger than the per-profile limit so different profiles do not
    // block each other. Admission itself is enforced transactionally in DB.
    concurrency: Math.max(
      5,
      Math.min(100, Number(process.env.GENERATION_GLOBAL_CONCURRENCY) || Number(process.env.WORKER_CONCURRENCY) || 50),
    ),
    // Stalled job detection: if a job's lock is not renewed within this interval,
    // BullMQ considers it stalled and re-delivers it (up to maxStalledCount).
    stalledInterval: 30000,
    maxStalledCount: 2,
    // Храним job для диагностики, но с жёстким age/count cap, чтобы Redis
    // не раздувался от SEO-задач.
    removeOnComplete: JOB_RETENTION.completed,
    removeOnFail:     JOB_RETENTION.failed,
  }
);

// Dedicated durable workers share the same process/container but have
// independent queues and concurrency limits. A Redis outage leaves the
// PostgreSQL outbox intact; the reliability scheduler in API reconciles it.
let parserWorker = null;
let siteCrawlerWorker = null;
schemaReady
  .then(() => {
    parserWorker = createParserWorker();
    siteCrawlerWorker = createSiteCrawlerWorker();
    console.log('[Worker] parser/site-crawler workers started after reliability schema check');
  })
  .catch((e) => console.error('[Worker] parser/site-crawler workers not started:', e.message));

// -----------------------------------------------------------------
// Глобальные события воркера
// -----------------------------------------------------------------

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} completed (task: ${job.data.taskId})`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed (task: ${job?.data?.taskId}): ${err.message}`);
});

worker.on('stalled', (jobId) => {
  console.warn(`[Worker] Job ${jobId} stalled — BullMQ will retry it automatically`);
});

worker.on('error', (err) => {
  console.error('[Worker] Worker-level error:', err.message);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────
// Requeue work owned by this worker before closing BullMQ. Without this step
// `docker compose down` leaves rows in processing/running until lease expiry;
// a fast `up` then looks like a stuck task instead of an immediate resume.
async function requeueWorkerOwnedTasks() {
  const recovered = { generation: 0, parserItems: 0, crawls: 0 };
  try {
    const generation = await db.query(
      `UPDATE tasks
          SET status='queued', bull_job_id=NULL, worker_id=NULL,
              lease_token=NULL, lease_until=NULL, heartbeat_at=NOW(),
              last_error_code='worker_shutdown', updated_at=NOW()
        WHERE worker_id=$1 AND status='processing'
        RETURNING id`,
      [WORKER_ID],
    );
    recovered.generation = generation.rowCount || 0;
    const generationIds = generation.rows.map((row) => row.id).filter(Boolean);
    if (generationIds.length) {
      await db.query(
        `DELETE FROM user_task_slot_leases
          WHERE task_type='generation' AND task_id = ANY($1::uuid[])`,
        [generationIds],
      ).catch(() => {});
    }
  } catch (error) {
    console.warn('[Worker] generation shutdown requeue failed:', error.message);
  }

  try {
    const parserItems = await db.query(
      `UPDATE parser_task_items
          SET status='queued', worker_id=NULL, lease_token=NULL, lease_until=NULL,
              heartbeat_at=NOW(), next_attempt_at=NOW(),
              error_code='worker_shutdown',
              error_message='Worker остановлен; элемент будет возобновлён',
              updated_at=NOW(), finished_at=NULL
        WHERE worker_id=$1 AND status='running'
        RETURNING id`,
      [WORKER_ID],
    );
    recovered.parserItems = parserItems.rowCount || 0;
  } catch (error) {
    console.warn('[Worker] parser shutdown requeue failed:', error.message);
  }

  try {
    const crawls = await db.query(
      `UPDATE site_crawl_tasks
          SET status='queued', worker_id=NULL, lease_token=NULL, lease_until=NULL,
              heartbeat_at=NOW(), error='Worker остановлен; crawl будет возобновлён',
              updated_at=NOW(), finished_at=NULL
        WHERE worker_id=$1 AND status='running'
        RETURNING id`,
      [WORKER_ID],
    );
    recovered.crawls = crawls.rowCount || 0;
  } catch (error) {
    console.warn('[Worker] site-crawl shutdown requeue failed:', error.message);
  }
  console.log('[Worker] shutdown recovery:', recovered);
  return recovered;
}

async function gracefulShutdown(signal) {
  console.log(`[Worker] ${signal} received — closing all workers gracefully...`);
  try {
    await requeueWorkerOwnedTasks();
    await Promise.all([
      worker.close(true),
      parserWorker ? parserWorker.close(true) : Promise.resolve(),
      siteCrawlerWorker ? siteCrawlerWorker.close(true) : Promise.resolve(),
    ]);
    console.log('[Worker] All workers closed, active jobs returned to queues');
  } catch (err) {
    console.error('[Worker] Error during graceful shutdown:', err.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = { worker, parserWorker, siteCrawlerWorker };
