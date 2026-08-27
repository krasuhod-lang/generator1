'use strict';

/**
 * reports/tasksAutoLog.js — единый журнал фактически выполненных работ проекта.
 *
 * Для завершённых модульных задач дата работы берётся из completed_at. updated_at
 * не является датой написания: он меняется при heartbeat, retry, аудите и
 * последующих технических обновлениях. performed_at остаётся DATE для старого
 * report contract, а performed_at_ts хранит точный timestamp завершения.
 */

const db = require('../../config/db');

const ALLOWED_TYPES = new Set(['content_generation', 'meta_update', 'link_article', 'technical_seo', 'other']);
const ALLOWED_SOURCES = new Set(['platform_auto', 'manual']);

function _dateParts(value) {
  const parsed = value ? new Date(value) : new Date();
  const safe = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  return {
    timestamp: safe.toISOString(),
    date: safe.toISOString().slice(0, 10),
    source: value ? 'explicit' : 'recorded_at',
  };
}

async function recordTask(payload = {}) {
  try {
    const projectId = payload.projectId || payload.project_id;
    if (!projectId) return null;
    const taskType = ALLOWED_TYPES.has(payload.taskType) ? payload.taskType : 'other';
    const source = ALLOWED_SOURCES.has(payload.source) ? payload.source : 'platform_auto';
    const title = String(payload.title || '').slice(0, 512);
    if (!title) return null;
    const performed = _dateParts(payload.performedAt || payload.performed_at);
    const { rows } = await db.query(
      `INSERT INTO tasks_auto_log
        (project_id, user_id, task_type, title, description,
         performed_at, performed_at_ts, performed_at_source,
         source, ref_table, ref_id, opportunity_id, analysis_id,
         source_snapshot_id, success_metric, after_check_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [
        projectId,
        payload.userId || payload.user_id || null,
        taskType,
        title,
        payload.description || null,
        performed.date,
        performed.timestamp,
        performed.source,
        source,
        payload.refTable || null,
        payload.refId || null,
        payload.opportunityId || payload.opportunity_id || null,
        payload.analysisId || payload.analysis_id || null,
        payload.sourceSnapshotId || payload.source_snapshot_id || null,
        payload.successMetric || payload.success_metric || null,
        payload.afterCheckDueAt || payload.after_check_due_at || null,
      ],
    );
    return rows[0]?.id || null;
  } catch (err) {
    console.warn('[tasksAutoLog] recordTask failed:', err.message);
    return null;
  }
}

function _completionProjection(completedColumn = 'completed_at', fallback = 'created_at') {
  return `
          (COALESCE(${completedColumn}, ${fallback}) AT TIME ZONE 'UTC')::date AS performed_at,
          COALESCE(${completedColumn}, ${fallback}) AS performed_at_ts,
          CASE WHEN ${completedColumn} IS NOT NULL THEN 'completed_at' ELSE 'legacy_fallback' END::text AS performed_at_source`;
}

/**
 * Backfill sources. `table` is used only for existence diagnostics; SQL is
 * still kept explicit/whitelisted. Each source is run under a savepoint so a
 * partially migrated optional module cannot hide all other completed work.
 */
const MODULE_SEGMENTS = [
  {
    table: 'tasks',
    sql: `SELECT project_id, user_id, 'content_generation' AS task_type,
                 ('SEO-текст: ' || COALESCE(NULLIF(input_target_service, ''), NULLIF(title, ''), 'без темы')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'tasks' AS ref_table, id AS ref_id,
                 NULL::uuid AS opportunity_id, NULL::uuid AS analysis_id,
                 NULL::uuid AS source_snapshot_id, NULL::text AS success_metric
            FROM tasks
           WHERE project_id = $1 AND status::text = 'completed'`,
  },
  {
    table: 'info_article_tasks',
    sql: `SELECT project_id, user_id, 'content_generation' AS task_type,
                 ('Статья: ' || COALESCE(NULLIF(topic, ''), 'без темы')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'info_article_tasks' AS ref_table, id AS ref_id,
                 opportunity_id, analysis_id, source_snapshot_id, NULL::text AS success_metric
            FROM info_article_tasks
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'link_article_tasks',
    sql: `SELECT project_id, user_id, 'link_article' AS task_type,
                 ('Ссылочная статья: ' || COALESCE(NULLIF(topic, ''), NULLIF(anchor_text, ''), 'без темы')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'link_article_tasks' AS ref_table, id AS ref_id,
                 opportunity_id, analysis_id, source_snapshot_id, NULL::text AS success_metric
            FROM link_article_tasks
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'meta_tag_tasks',
    sql: `SELECT project_id, user_id, 'meta_update' AS task_type,
                 ('Мета-теги: ' || COALESCE(NULLIF(name, ''), 'без названия')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'meta_tag_tasks' AS ref_table, id AS ref_id,
                 opportunity_id, analysis_id, source_snapshot_id, NULL::text AS success_metric
            FROM meta_tag_tasks
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'article_topic_tasks',
    sql: `SELECT project_id, user_id, 'content_generation' AS task_type,
                 ('Подбор тем статей: ' || COALESCE(NULLIF(niche, ''), 'без ниши')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'article_topic_tasks' AS ref_table, id AS ref_id,
                 NULL::uuid AS opportunity_id, NULL::uuid AS analysis_id,
                 NULL::uuid AS source_snapshot_id, NULL::text AS success_metric
            FROM article_topic_tasks
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'relevance_reports',
    sql: `SELECT project_id, user_id, 'other' AS task_type,
                 ('Анализ релевантности: ' || COALESCE(NULLIF(query, ''), 'без запроса')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'relevance_reports' AS ref_table, id AS ref_id,
                 NULL::uuid AS opportunity_id, NULL::uuid AS analysis_id,
                 NULL::uuid AS source_snapshot_id, NULL::text AS success_metric
            FROM relevance_reports
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'forecaster_tasks',
    sql: `SELECT project_id, user_id, 'other' AS task_type,
                 ('Прогноз трафика: ' || COALESCE(NULLIF(name, ''), NULLIF(source_filename, ''), 'без названия')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'forecaster_tasks' AS ref_table, id AS ref_id,
                 NULL::uuid AS opportunity_id, NULL::uuid AS analysis_id,
                 NULL::uuid AS source_snapshot_id, NULL::text AS success_metric
            FROM forecaster_tasks
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'serp_b2b_tasks',
    sql: `SELECT project_id, user_id, 'other' AS task_type,
                 ('SERP-анализ B2B: ' || COALESCE(NULLIF(name, ''), NULLIF(query, ''), 'без запроса')) AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'serp_b2b_tasks' AS ref_table, id AS ref_id,
                 NULL::uuid AS opportunity_id, NULL::uuid AS analysis_id,
                 NULL::uuid AS source_snapshot_id, NULL::text AS success_metric
            FROM serp_b2b_tasks
           WHERE project_id = $1 AND status::text = 'done'`,
  },
  {
    table: 'project_analyses',
    sql: `SELECT project_id, user_id, 'other' AS task_type,
                 'AI-аналитика проекта (GSC)' AS title,
                 ${_completionProjection('completed_at', 'created_at')},
                 'project_analyses' AS ref_table, id AS ref_id,
                 NULL::uuid AS opportunity_id, id AS analysis_id,
                 snapshot_id AS source_snapshot_id, NULL::text AS success_metric
            FROM project_analyses
           WHERE project_id = $1 AND status::text = 'done'`,
  },
];

async function _existingModuleSegments() {
  try {
    const { rows } = await db.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [MODULE_SEGMENTS.map((segment) => segment.table)],
    );
    const existing = new Set(rows.map((row) => row.table_name));
    return MODULE_SEGMENTS.filter((segment) => existing.has(segment.table));
  } catch (err) {
    console.warn('[tasksAutoLog] source discovery failed; trying all segments:', err.message);
    return MODULE_SEGMENTS;
  }
}

/**
 * Идемпотентный backfill tasks_auto_log из всех доступных модулей. Advisory
 * lock устраняет гонку двух параллельных report requests, а savepoint делает
 * синхронизацию fail-open для частично применённых legacy migrations.
 */
async function syncFromModules(projectId) {
  if (!projectId) return 0;
  let client;
  try {
    const segments = await _existingModuleSegments();
    if (!segments.length) return 0;
    client = await db.getClient();
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`tasks-auto-log:${projectId}`]);

    let inserted = 0;
    for (const segment of segments) {
      await client.query('SAVEPOINT tasks_auto_log_segment');
      try {
        // Repair previously backfilled rows first. This is what fixes old
        // entries whose performed_at was derived from updated_at/created_at.
        await client.query(
          `UPDATE tasks_auto_log l
              SET performed_at = s.performed_at,
                  performed_at_ts = s.performed_at_ts,
                  performed_at_source = s.performed_at_source
             FROM (${segment.sql}) s
            WHERE l.project_id = s.project_id
              AND l.ref_table = s.ref_table
              AND l.ref_id = s.ref_id
              AND (l.performed_at IS DISTINCT FROM s.performed_at
                   OR l.performed_at_ts IS DISTINCT FROM s.performed_at_ts
                   OR l.performed_at_source IS DISTINCT FROM s.performed_at_source)`,
          [projectId],
        );
        const result = await client.query(
          `INSERT INTO tasks_auto_log
             (project_id, user_id, task_type, title, performed_at,
              performed_at_ts, performed_at_source, source, ref_table, ref_id,
              opportunity_id, analysis_id, source_snapshot_id, success_metric)
           SELECT s.project_id, s.user_id, s.task_type, LEFT(s.title, 512),
                  s.performed_at, s.performed_at_ts, s.performed_at_source,
                  'platform_auto', s.ref_table, s.ref_id,
                  s.opportunity_id, s.analysis_id, s.source_snapshot_id, s.success_metric
             FROM (${segment.sql}) s
            WHERE NOT EXISTS (
                    SELECT 1 FROM tasks_auto_log l
                     WHERE l.project_id = s.project_id
                       AND l.ref_table = s.ref_table
                       AND l.ref_id = s.ref_id
                  )`,
          [projectId],
        );
        inserted += result.rowCount || 0;
        await client.query('RELEASE SAVEPOINT tasks_auto_log_segment');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT tasks_auto_log_segment');
        console.warn(`[tasksAutoLog] source ${segment.table} skipped:`, err.message);
      }
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    try { await client?.query('ROLLBACK'); } catch (_) {}
    console.warn('[tasksAutoLog] syncFromModules failed:', err.message);
    return 0;
  } finally {
    client?.release();
  }
}

async function listForPeriod(projectId, dateFrom, dateTo, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  const { rows } = await db.query(
    `SELECT id, task_type, title, description, performed_at,
            performed_at_ts, performed_at_source,
            source, is_hidden, ref_table, ref_id, opportunity_id, analysis_id,
            source_snapshot_id, success_metric, after_check_due_at
       FROM tasks_auto_log
      WHERE project_id = $1
        AND performed_at >= $2::date
        AND performed_at <= $3::date
        ${includeHidden ? '' : 'AND is_hidden = FALSE'}
      ORDER BY performed_at DESC, performed_at_ts DESC NULLS LAST, created_at DESC`,
    [projectId, dateFrom, dateTo],
  );
  return rows;
}

async function setHidden(projectId, taskId, isHidden) {
  const { rowCount } = await db.query(
    `UPDATE tasks_auto_log SET is_hidden = $3
       WHERE id = $1 AND project_id = $2`,
    [taskId, projectId, !!isHidden],
  );
  return rowCount > 0;
}

async function summarizeByType(projectId, dateFrom, dateTo) {
  const { rows } = await db.query(
    `SELECT task_type, COUNT(*)::int AS count
       FROM tasks_auto_log
      WHERE project_id = $1
        AND performed_at >= $2::date
        AND performed_at <= $3::date
        AND is_hidden = FALSE
      GROUP BY task_type`,
    [projectId, dateFrom, dateTo],
  );
  const map = { content_generation: 0, meta_update: 0, link_article: 0, technical_seo: 0, other: 0 };
  for (const row of rows) map[row.task_type] = row.count;
  const total = Object.values(map).reduce((sum, value) => sum + value, 0);
  return { total_generated: total, by_type: map };
}

module.exports = {
  recordTask,
  listForPeriod,
  listForProject: listForPeriod,
  setHidden,
  summarizeByType,
  syncFromModules,
  MODULE_SEGMENTS,
};
