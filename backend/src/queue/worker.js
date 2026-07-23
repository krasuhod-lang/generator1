'use strict';

const { Worker } = require('bullmq');
const { connection, JOB_RETENTION } = require('./queue');
const db             = require('../config/db');
const { publish }    = require('../services/sse/sseManager');

const { runPipeline, PipelinePausedError } = require('../services/pipeline/orchestrator');

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

    // ── 1b. Определяем точку возобновления ────────────────────────
    // При первой постановке job.data.resumeFrom обычно null. Если этот job
    // перезапускается BullMQ (stalled после рестарта воркера) или задача уже
    // была в работе (status='processing') — берём последний checkpoint из БД,
    // чтобы продолжить с последнего сохранённого блока, а не со Stage 0.
    let resumeFrom = job.data.resumeFrom || null;
    if (!resumeFrom && (job.attemptsMade > 0 || task.status === 'processing')) {
      if (task.pipeline_checkpoint) {
        resumeFrom = task.pipeline_checkpoint;
        const fromBlock = resumeFrom.resumeFromBlock ?? 0;
        log(taskId, `Возобновление после рестарта: восстановлен checkpoint (блок ${fromBlock + 1})`, 'warn');
      }
    }

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
        resumeFrom,
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
    // Долгие LLM-стадии (Stage 0-7 SEO-задачи) держат job активным десятки минут.
    // Дефолтный lockDuration BullMQ (30с) пометил бы живой job как «stalled» и
    // перезапустил его. Поднимаем lock/renew, чтобы медленный, но работающий job
    // не считался зависшим. maxStalledCount=1 — после реального рестарта воркера
    // job однократно переустанавливается и продолжает с checkpoint (см. выше).
    lockDuration:   parseInt(process.env.WORKER_LOCK_DURATION) || 5 * 60 * 1000,
    stalledInterval: parseInt(process.env.WORKER_STALLED_INTERVAL) || 60 * 1000,
    maxStalledCount: parseInt(process.env.WORKER_MAX_STALLED) || 1,
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

// -----------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------
// При обновлении Docker шлёт контейнеру SIGTERM. Закрываем воркер аккуратно:
// worker.close() дожидается завершения активного шага и корректно освобождает
// lock job'а в Redis. Незавершённый job останется в очереди (active) и после
// рестарта продолжится с последнего checkpoint (см. resumeFrom выше).
let _shuttingDown = false;
async function gracefulShutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[Worker] Получен ${signal} — graceful shutdown...`);
  try {
    await worker.close(); // не форсируем: даём активному job завершить текущий шаг
    console.log('[Worker] Воркер остановлен, lock освобождён.');
  } catch (e) {
    console.error('[Worker] Ошибка при закрытии воркера:', e.message);
  }
  try {
    if (db && db.pool && typeof db.pool.end === 'function') await db.pool.end();
  } catch (_) { /* пул мог быть уже закрыт */ }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = { worker };
