'use strict';
/**
 * recoverTasks — стартовая авто-реанимация «осиротевших» задач генерации.
 *
 * После рестарта сервера/воркера задача может остаться в статусе `processing`,
 * хотя её Bull-job больше не существует (например, был удалён или потерян).
 * Такую задачу никто не поднимет автоматически. Этот sweep находит подобные
 * задачи и переустанавливает их в очередь с `resumeFrom` из pipeline_checkpoint,
 * чтобы генерация продолжилась с последнего сохранённого блока, а не со Stage 0.
 *
 * Идемпотентность:
 *  - задачи, чей Bull-job ещё жив (active/waiting/delayed), пропускаются —
 *    их подхватит воркер (в т.ч. через stalled-reclaim BullMQ);
 *  - повторная постановка использует детерминированный jobId, поэтому
 *    параллельные реплики не создают дублей.
 *
 * Управляется флагом TASK_RECOVERY_ON_BOOT (по умолчанию включено; '0' — выкл).
 */

const db = require('../config/db');
const { generationQueue } = require('./queue');

// Состояния Bull-job, при которых задача считается «ещё в работе/очереди».
const LIVE_JOB_STATES = new Set([
  'active', 'waiting', 'waiting-children', 'delayed', 'prioritized', 'paused',
]);

async function isJobStillLive(bullJobId) {
  if (!bullJobId) return false;
  try {
    const job = await generationQueue.getJob(bullJobId);
    if (!job) return false;
    const state = await job.getState();
    return LIVE_JOB_STATES.has(state);
  } catch (e) {
    console.warn(`[RecoverTasks] Не удалось проверить job ${bullJobId}:`, e.message);
    return false;
  }
}

/**
 * @returns {Promise<{recovered: number, skipped: number, failed: number}>}
 */
async function recoverOrphanTasks() {
  const stats = { recovered: 0, skipped: 0, failed: 0 };

  if (process.env.TASK_RECOVERY_ON_BOOT === '0') {
    console.log('[RecoverTasks] Отключено (TASK_RECOVERY_ON_BOOT=0).');
    return stats;
  }

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, bull_job_id, pipeline_checkpoint, status
         FROM tasks
        WHERE status IN ('processing', 'queued')
        ORDER BY updated_at ASC`,
    ));
  } catch (e) {
    console.warn('[RecoverTasks] Не удалось прочитать задачи:', e.message);
    return stats;
  }

  if (!rows.length) return stats;

  for (const task of rows) {
    if (await isJobStillLive(task.bull_job_id)) {
      stats.skipped++;
      continue;
    }

    const checkpoint = task.pipeline_checkpoint || null;
    const resumeFromBlock = checkpoint?.resumeFromBlock ?? 0;

    try {
      const jobId = `${task.id}-recover-${resumeFromBlock}`;
      const job = await generationQueue.add(
        'generate',
        { taskId: task.id, resumeFrom: checkpoint },
        { jobId, attempts: 1 },
      );

      await db.query(
        `UPDATE tasks
            SET status = 'queued', bull_job_id = $1, error_message = NULL, updated_at = NOW()
          WHERE id = $2`,
        [String(job.id), task.id],
      );

      stats.recovered++;
      console.log(
        `[RecoverTasks] Задача ${task.id.slice(0, 8)}… переустановлена в очередь ` +
        `(resume с блока ${resumeFromBlock + 1}).`,
      );
    } catch (e) {
      stats.failed++;
      console.warn(`[RecoverTasks] Не удалось переустановить задачу ${task.id.slice(0, 8)}…:`, e.message);
    }
  }

  console.log(
    `[RecoverTasks] Готово: восстановлено ${stats.recovered}, пропущено ${stats.skipped}, ошибок ${stats.failed}.`,
  );
  return stats;
}

module.exports = { recoverOrphanTasks };
