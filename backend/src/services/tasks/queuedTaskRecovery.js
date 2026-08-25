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
    claimColumns: true,
    handler: () => require('../infoArticle/infoArticlePipeline').processInfoArticleTask,
  },
  {
    kind: 'link_article',
    table: 'link_article_tasks',
    statuses: ['queued'],
    queueStatus: 'queued',
    activeStatuses: ['running', 'in_progress'],
    claimColumns: true,
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
    statuses: ['pending'],
    queueStatus: 'pending',
    activeStatuses: ['processing', 'running', 'in_progress'],
    activeStages: ['serp', 'fetching_pages', 'analyzing', 'comparing'],
    staleRecovery: true,
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
let staleRecoveryRunning = false;
const STALE_ACTIVE_AFTER_SECONDS = Math.max(
  120,
  Number(process.env.USER_TASK_STALE_RECOVERY_SECONDS) || 180,
);

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
            WHERE status::text = ANY($1::text[])
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
      const activeStages = Array.isArray(spec.activeStages) ? spec.activeStages : [];
      const claimReset = spec.claimColumns
        ? 'execution_token = NULL, execution_started_at = NULL,'
        : '';
      const query = activeStages.length > 0
        ? `UPDATE ${spec.table}
              SET status = $1,
                  error_message = 'Задача возвращена в очередь перед перезапуском сервера',
                  ${claimReset}
                  updated_at = NOW()
            WHERE (status::text = ANY($2::text[]) OR current_stage::text = ANY($3::text[]))`
        : `UPDATE ${spec.table}
              SET status = $1,
                  error_message = 'Задача возвращена в очередь перед перезапуском сервера',
                  ${claimReset}
                  updated_at = NOW()
            WHERE status::text = ANY($2::text[])`;
      const params = activeStages.length > 0
        ? [spec.queueStatus || spec.statuses[0], spec.activeStatuses, activeStages]
        : [spec.queueStatus || spec.statuses[0], spec.activeStatuses];
      const { rowCount } = await db.query(query, params);
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

async function recoverStaleActiveUserTasks(db = dbDefault) {
  if (staleRecoveryRunning) return { skipped: true, reason: 'stale_recovery_already_running' };
  staleRecoveryRunning = true;
  const launched = [];
  try {
    for (const spec of TASK_REGISTRY) {
      if (!spec.staleRecovery || !Array.isArray(spec.activeStatuses) || spec.activeStatuses.length === 0) continue;
      let rows;
      try {
        const activeStages = Array.isArray(spec.activeStages) ? spec.activeStages : [];
        ({ rows } = await db.query(
          `SELECT id, user_id, status, current_stage
             FROM ${spec.table}
            WHERE (status::text = ANY($1::text[]) OR current_stage::text = ANY($2::text[]))
              AND updated_at < NOW() - make_interval(secs => $3)
              AND NOT EXISTS (
                SELECT 1
                  FROM user_task_slot_leases l
                 WHERE l.user_id = ${spec.table}.user_id
                   AND l.task_type = $4
                   AND l.task_id = ${spec.table}.id::text
                   AND l.lease_until > NOW()
              )
            ORDER BY updated_at ASC
            LIMIT $5`,
          [spec.activeStatuses, activeStages, STALE_ACTIVE_AFTER_SECONDS, spec.kind, RECOVERY_BATCH_PER_TYPE],
        ));
      } catch (error) {
        // During rolling deploys the lease table or an optional legacy table may
        // not exist yet; normal queued recovery must continue independently.
        if (!/relation .* does not exist/i.test(String(error.message || error))) {
          console.warn(`[UserTaskRecovery] stale ${spec.kind} scan failed:`, error.message);
        }
        continue;
      }
      if (!rows || rows.length === 0) continue;
      const processTask = spec.handler();
      for (const row of rows) {
        const taskId = String(row.id);
        const moved = await db.query(
          `UPDATE ${spec.table}
              SET status = $1,
                  error_message = 'Задача возвращена в очередь после потери процесса',
                  updated_at = NOW()
            WHERE id = $2
              AND (status::text = ANY($3::text[]) OR current_stage::text = ANY($4::text[]))
              AND NOT EXISTS (
                SELECT 1
                  FROM user_task_slot_leases l
                 WHERE l.user_id = ${spec.table}.user_id
                   AND l.task_type = $5
                   AND l.task_id = ${spec.table}.id::text
                   AND l.lease_until > NOW()
              )
            RETURNING id, user_id`,
          [spec.queueStatus || spec.statuses[0], row.id, spec.activeStatuses, spec.activeStages || [], spec.kind],
        );
        if (!moved.rows?.length) continue;
        const alreadyScheduled = isUserTaskScheduled(spec.kind, taskId);
        const result = scheduleUserTask(row.user_id, spec.kind, taskId, () => processTask(taskId));
        if (!alreadyScheduled) launched.push(`${spec.kind}:${taskId}`);
        result.catch((error) => {
          console.error(`[UserTaskRecovery] stale ${spec.kind}/${taskId} failed:`, error.message);
        });
      }
    }
    return { launched: launched.length, tasks: launched };
  } finally {
    staleRecoveryRunning = false;
  }
}

function startQueuedUserTaskRecovery(db = dbDefault) {
  if (recoveryTimer) return () => stopQueuedUserTaskRecovery();
  const tick = async () => {
    try {
      await recoverQueuedUserTasks(db);
      await recoverStaleActiveUserTasks(db);
    } catch (error) {
      console.warn('[UserTaskRecovery] tick failed:', error.message);
    }
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
    staleActiveAfterSeconds: STALE_ACTIVE_AFTER_SECONDS,
    taskTypes: TASK_REGISTRY.map((item) => item.kind),
  };
}

module.exports = {
  TASK_REGISTRY,
  recoverQueuedUserTasks,
  recoverStaleActiveUserTasks,
  startQueuedUserTaskRecovery,
  stopQueuedUserTaskRecovery,
  requeueActiveUserTasksForShutdown,
  getQueuedUserTaskRecoveryConfig,
};
