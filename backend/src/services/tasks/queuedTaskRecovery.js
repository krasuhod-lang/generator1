'use strict';

const dbDefault = require('../../config/db');
const { scheduleUserTask, isUserTaskScheduled } = require('../../utils/perUserConcurrency');

const RECOVERY_INTERVAL_MS = Math.max(
  10000,
  Number(process.env.USER_TASK_RECOVERY_INTERVAL_MS) || 15000,
);
const RECOVERY_BATCH_PER_TYPE = Math.max(
  1,
  Math.min(100, Number(process.env.USER_TASK_RECOVERY_BATCH) || 25),
);

// Direct pipelines historically used setImmediate() and their own in-memory
// queues. These rows therefore need an explicit startup/periodic launcher;
// BullMQ recovery cannot see them.
const TASK_REGISTRY = Object.freeze([
  {
    kind: 'info_article',
    table: 'info_article_tasks',
    statuses: ['queued'],
    queueStatus: 'queued',
    activeStatuses: ['running', 'in_progress'],
    handler: () => require('../infoArticle/infoArticlePipeline').processInfoArticleTask,
  },
  {
    kind: 'link_article',
    table: 'link_article_tasks',
    statuses: ['queued'],
    queueStatus: 'queued',
    activeStatuses: ['running', 'in_progress'],
    handler: () => require('../linkArticle/linkArticlePipeline').processLinkArticleTask,
  },
  {
    kind: 'meta_tags',
    table: 'meta_tag_tasks',
    statuses: ['pending', 'queued'],
    queueStatus: 'queued',
    activeStatuses: ['processing', 'running', 'in_progress'],
    handler: () => require('../metaTags/pipeline').processMetaTagTask,
  },
  {
    kind: 'article_topics',
    table: 'article_topic_tasks',
    statuses: ['queued', 'pending'],
    queueStatus: 'queued',
    activeStatuses: ['processing', 'running', 'in_progress'],
    handler: () => require('../articleTopics/articleTopicsPipeline').processArticleTopicTask,
  },
  {
    kind: 'category_lead',
    table: 'category_lead_tasks',
    statuses: ['queued', 'pending'],
    queueStatus: 'queued',
    activeStatuses: ['processing', 'running', 'in_progress'],
    handler: () => require('../categoryLead/pipeline').processCategoryLeadTask,
  },
  {
    kind: 'forecaster',
    table: 'forecaster_tasks',
    statuses: ['queued', 'pending'],
    queueStatus: 'queued',
    activeStatuses: ['processing', 'running', 'in_progress'],
    handler: () => require('../forecaster/forecasterPipeline').processForecasterTask,
  },
  {
    kind: 'relevance',
    table: 'relevance_reports',
    statuses: ['queued', 'pending'],
    queueStatus: 'queued',
    activeStatuses: ['processing', 'running', 'in_progress'],
    handler: () => require('../relevance/pipeline').processRelevanceReport,
  },
  {
    kind: 'serp_b2b',
    table: 'serp_b2b_tasks',
    statuses: ['queued', 'pending'],
    queueStatus: 'queued',
    activeStatuses: ['processing', 'running', 'in_progress'],
    handler: () => require('../serpB2b/pipeline').processSerpB2bTask,
  },
]);

let recoveryTimer = null;
let recoveryRunning = false;

async function recoverQueuedUserTasks(db = dbDefault) {
  if (recoveryRunning) return { skipped: true, reason: 'recovery_already_running' };
  recoveryRunning = true;
  const launched = [];
  try {
    for (const spec of TASK_REGISTRY) {
      let rows;
      try {
        ({ rows } = await db.query(
          `SELECT id, user_id
             FROM ${spec.table}
            WHERE status = ANY($1::text[])
            ORDER BY created_at ASC
            LIMIT $2`,
          [spec.statuses, RECOVERY_BATCH_PER_TYPE],
        ));
      } catch (error) {
        // Keep one optional/legacy table from disabling recovery for all other
        // direct launchers during rolling migrations.
        if (!/relation .* does not exist/i.test(String(error.message || error))) {
          console.warn(`[UserTaskRecovery] ${spec.kind} scan failed:`, error.message);
        }
        continue;
      }

      if (!rows || rows.length === 0) continue;
      const processTask = spec.handler();
      for (const row of rows) {
        const taskId = String(row.id);
        const alreadyScheduled = isUserTaskScheduled(spec.kind, taskId);
        const result = scheduleUserTask(row.user_id, spec.kind, taskId, () => processTask(taskId));
        if (!alreadyScheduled) launched.push(`${spec.kind}:${taskId}`);
        result.catch((error) => {
          console.error(`[UserTaskRecovery] ${spec.kind}/${taskId} failed:`, error.message);
        });
      }
    }
    return { launched: launched.length, tasks: launched };
  } finally {
    recoveryRunning = false;
  }
}

function stopQueuedUserTaskRecovery() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

/**
 * Переводит direct-задачи, реально выполнявшиеся в API-процессе, обратно в
 * queued до SIGTERM. Это исключает ожидание истечения lease после `docker
 * compose down` и позволяет startup recovery запустить их сразу.
 */
async function requeueActiveUserTasksForShutdown(db = dbDefault) {
  const result = { requeued: 0, byType: {} };
  for (const spec of TASK_REGISTRY) {
    if (!Array.isArray(spec.activeStatuses) || spec.activeStatuses.length === 0) continue;
    try {
      const { rowCount } = await db.query(
        `UPDATE ${spec.table}
            SET status = $1,
                error_message = 'Задача возвращена в очередь перед перезапуском сервера',
                updated_at = NOW()
          WHERE status::text = ANY($2::text[])`,
        [spec.queueStatus || spec.statuses[0], spec.activeStatuses],
      );
      result.byType[spec.kind] = rowCount || 0;
      result.requeued += rowCount || 0;
    } catch (error) {
      if (!/relation .* does not exist/i.test(String(error.message || error))) {
        console.warn(`[UserTaskRecovery] shutdown requeue ${spec.kind} failed:`, error.message);
      }
    }
  }
  return result;
}

function startQueuedUserTaskRecovery(db = dbDefault) {
  if (recoveryTimer) return () => stopQueuedUserTaskRecovery();
  const tick = () => {
    recoverQueuedUserTasks(db).catch((error) => {
      console.warn('[UserTaskRecovery] tick failed:', error.message);
    });
  };
  setImmediate(tick);
  recoveryTimer = setInterval(tick, RECOVERY_INTERVAL_MS);
  if (recoveryTimer.unref) recoveryTimer.unref();
  return () => stopQueuedUserTaskRecovery();
}

function getQueuedUserTaskRecoveryConfig() {
  return {
    intervalMs: RECOVERY_INTERVAL_MS,
    batchPerType: RECOVERY_BATCH_PER_TYPE,
    taskTypes: TASK_REGISTRY.map((item) => item.kind),
  };
}

module.exports = {
  TASK_REGISTRY,
  recoverQueuedUserTasks,
  startQueuedUserTaskRecovery,
  stopQueuedUserTaskRecovery,
  requeueActiveUserTasksForShutdown,
  getQueuedUserTaskRecoveryConfig,
};
