'use strict';

/**
 * reports/tasksAutoLog.js — лог «выполненных работ» для блоков отчёта.
 *
 *   recordTask(payload) — записать событие. Никогда не бросает (best-effort
 *                         логирование, чтобы хук в пайплайне генерации не
 *                         ломал основную задачу).
 *   listForPeriod(projectId, from, to, {includeHidden}) — выборка для отчёта.
 *   listForProject(...) — без даты.
 *   syncFromModules(projectId) — backfill лога из таблиц модулей: завершённые
 *                         задачи (статьи, мета-теги, ссылочные, темы,
 *                         релевантность, прогнозы, SERP B2B, AI-аналитика)
 *                         с project_id попадают в лог идемпотентно (по
 *                         ref_table/ref_id), включая сделанные ранее.
 */

const db = require('../../config/db');

const ALLOWED_TYPES = new Set(['content_generation', 'meta_update', 'link_article', 'technical_seo', 'other']);
const ALLOWED_SOURCES = new Set(['platform_auto', 'manual']);

async function recordTask(payload = {}) {
  try {
    const projectId = payload.projectId || payload.project_id;
    if (!projectId) return null;
    const taskType = ALLOWED_TYPES.has(payload.taskType) ? payload.taskType : 'other';
    const source = ALLOWED_SOURCES.has(payload.source) ? payload.source : 'platform_auto';
    const title = String(payload.title || '').slice(0, 512);
    if (!title) return null;
    const performedAt = payload.performedAt
      ? new Date(payload.performedAt).toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);
    const { rows } = await db.query(
      `INSERT INTO tasks_auto_log
        (project_id, user_id, task_type, title, description,
         performed_at, source, ref_table, ref_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        projectId,
        payload.userId || payload.user_id || null,
        taskType,
        title,
        payload.description || null,
        performedAt,
        source,
        payload.refTable || null,
        payload.refId || null,
      ],
    );
    return rows[0]?.id || null;
  } catch (err) {
    console.warn('[tasksAutoLog] recordTask failed:', err.message);
    return null;
  }
}

// Сегменты backfill'а из таблиц модулей. Каждый SELECT приводится к общему
// виду (project_id, user_id, task_type, title, performed_at, ref_table,
// ref_id) и берёт только завершённые задачи, привязанные к проекту.
// Названия типов должны проходить CHECK-констрейнт tasks_auto_log.task_type.
const MODULE_SEGMENTS = [
  `SELECT project_id, user_id, 'content_generation' AS task_type,
          ('Статья: ' || COALESCE(NULLIF(topic, ''), 'без темы')) AS title,
          COALESCE(updated_at, created_at)::date AS performed_at,
          'info_article_tasks' AS ref_table, id AS ref_id
     FROM info_article_tasks
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'link_article' AS task_type,
          ('Ссылочная статья: ' || COALESCE(NULLIF(topic, ''), NULLIF(anchor_text, ''), 'без темы')) AS title,
          COALESCE(updated_at, created_at)::date AS performed_at,
          'link_article_tasks' AS ref_table, id AS ref_id
     FROM link_article_tasks
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'meta_update' AS task_type,
          ('Мета-теги: ' || COALESCE(NULLIF(name, ''), 'без названия')) AS title,
          created_at::date AS performed_at,
          'meta_tag_tasks' AS ref_table, id AS ref_id
     FROM meta_tag_tasks
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'content_generation' AS task_type,
          ('Подбор тем статей: ' || COALESCE(NULLIF(niche, ''), 'без ниши')) AS title,
          COALESCE(updated_at, created_at)::date AS performed_at,
          'article_topic_tasks' AS ref_table, id AS ref_id
     FROM article_topic_tasks
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'other' AS task_type,
          ('Анализ релевантности: ' || COALESCE(NULLIF(query, ''), 'без запроса')) AS title,
          created_at::date AS performed_at,
          'relevance_reports' AS ref_table, id AS ref_id
     FROM relevance_reports
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'other' AS task_type,
          ('Прогноз трафика: ' || COALESCE(NULLIF(name, ''), 'без названия')) AS title,
          COALESCE(updated_at, created_at)::date AS performed_at,
          'forecaster_tasks' AS ref_table, id AS ref_id
     FROM forecaster_tasks
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'other' AS task_type,
          ('SERP-анализ B2B: ' || COALESCE(NULLIF(name, ''), NULLIF(query, ''), 'без запроса')) AS title,
          COALESCE(updated_at, created_at)::date AS performed_at,
          'serp_b2b_tasks' AS ref_table, id AS ref_id
     FROM serp_b2b_tasks
    WHERE project_id = $1 AND status = 'done'`,
  `SELECT project_id, user_id, 'other' AS task_type,
          'AI-аналитика проекта (GSC)' AS title,
          COALESCE(completed_at, created_at)::date AS performed_at,
          'project_analyses' AS ref_table, id AS ref_id
     FROM project_analyses
    WHERE project_id = $1 AND status = 'done'`,
];

/**
 * Идемпотентный backfill tasks_auto_log из таблиц модулей: пайплайны
 * генерации сами лог не пишут, поэтому «Подтянуть работы» без синка
 * возвращал пустоту. Дедупликация — по (project_id, ref_table, ref_id).
 * Best-effort: ошибка синка не должна ломать сборку отчёта.
 */
async function syncFromModules(projectId) {
  if (!projectId) return 0;
  try {
    const unionSql = MODULE_SEGMENTS.join(' UNION ALL ');
    const { rowCount } = await db.query(
      `INSERT INTO tasks_auto_log
         (project_id, user_id, task_type, title, performed_at, source, ref_table, ref_id)
       SELECT s.project_id, s.user_id, s.task_type, LEFT(s.title, 512),
              s.performed_at, 'platform_auto', s.ref_table, s.ref_id
         FROM (${unionSql}) s
        WHERE NOT EXISTS (
                SELECT 1 FROM tasks_auto_log l
                 WHERE l.project_id = s.project_id
                   AND l.ref_table = s.ref_table
                   AND l.ref_id = s.ref_id
              )`,
      [projectId],
    );
    return rowCount || 0;
  } catch (err) {
    console.warn('[tasksAutoLog] syncFromModules failed:', err.message);
    return 0;
  }
}

async function listForPeriod(projectId, dateFrom, dateTo, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  const { rows } = await db.query(
    `SELECT id, task_type, title, description, performed_at,
            source, is_hidden, ref_table, ref_id
       FROM tasks_auto_log
      WHERE project_id = $1
        AND performed_at >= $2::date
        AND performed_at <= $3::date
        ${includeHidden ? '' : 'AND is_hidden = FALSE'}
      ORDER BY performed_at DESC, created_at DESC`,
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
  for (const r of rows) map[r.task_type] = r.count;
  const total = Object.values(map).reduce((s, v) => s + v, 0);
  return { total_generated: total, by_type: map };
}

module.exports = { recordTask, listForPeriod, listForProject: listForPeriod, setHidden, summarizeByType, syncFromModules };
