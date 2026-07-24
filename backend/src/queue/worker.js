'use strict';

const { Worker } = require('bullmq');
const { connection, JOB_RETENTION } = require('./queue');
const { generationQueue } = require('./queue');
const db             = require('../config/db');
const { publish }    = require('../services/sse/sseManager');

const { runPipeline, PipelinePausedError } = require('../services/pipeline/orchestrator');

// Максимум автоматических возобновлений задачи после ошибки пайплайна.
// Задача НЕ падает сразу в "failed": воркер сам переставляет её на возобновление
// с последнего checkpoint (без потери прогресса и без ручной перенастройки),
// и только исчерпав попытки — помечает "failed".
const PIPELINE_AUTO_RETRIES = Math.max(0, parseInt(process.env.PIPELINE_AUTO_RETRIES, 10) || 3);

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
async function updateTask(taskId, fields) {
  const keys   = Object.keys(fields);
  const values = Object.values(fields);
  const setClause = keys
    .map((k, i) => `${k} = $${i + 2}`)
    .join(', ');

  await db.query(
    `UPDATE tasks SET ${setClause}, updated_at = NOW() WHERE id = $1`,
    [taskId, ...values]
  );
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
    const { taskId } = job.data;

    // ── 1. Загрузка задачи ────────────────────────────────────────
    const task = await loadTask(taskId);

    // ── 2. Переводим в статус processing ─────────────────────────
    await updateTask(taskId, {
      status:     'processing',
      started_at: new Date(),
      bull_job_id: String(job.id),
    });

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
        status:       'completed',
        completed_at: new Date(),
      });

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
        await updateTask(taskId, {
          status:              'paused',
          pipeline_checkpoint: JSON.stringify(pipelineErr.checkpoint || {}),
        });

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

          await updateTask(taskId, {
            status:        'queued',
            bull_job_id:   String(retryJob.id),
            error_message: null,
          });

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
      await updateTask(taskId, {
        status:        'failed',
        error_message: errMsg.substring(0, 1000),
        completed_at:  new Date(),
      });

      log(taskId, `Ошибка пайплайна: ${errMsg}`, 'error');

      publish(taskId, {
        type:  'error',
        stage: 'pipeline',
        msg:   errMsg,
      });

      // Пробрасываем, чтобы BullMQ записал job в failed
      throw pipelineErr;
    }
  },

  {
    connection,
    concurrency: parseInt(process.env.WORKER_CONCURRENCY) || 3,
    // Храним job для диагностики, но с жёстким age/count cap, чтобы Redis
    // не раздувался от SEO-задач.
    removeOnComplete: JOB_RETENTION.completed,
    removeOnFail:     JOB_RETENTION.failed,
  }
);

// -----------------------------------------------------------------
// Глобальные события воркера
// -----------------------------------------------------------------

worker.on('completed', (job) => {
  console.log(`[Worker] Job ${job.id} completed (task: ${job.data.taskId})`);
});

worker.on('failed', (job, err) => {
  console.error(`[Worker] Job ${job?.id} failed (task: ${job?.data?.taskId}): ${err.message}`);
});

worker.on('error', (err) => {
  console.error('[Worker] Worker-level error:', err.message);
});

module.exports = { worker };
