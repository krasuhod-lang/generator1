'use strict';

/**
 * reports/tasksAutoLog.js — лог «выполненных работ» для блоков отчёта.
 *
 *   recordTask(payload) — записать событие. Никогда не бросает (best-effort
 *                         логирование, чтобы хук в пайплайне генерации не
 *                         ломал основную задачу).
 *   listForPeriod(projectId, from, to, {includeHidden}) — выборка для отчёта.
 *   listForProject(...) — без даты.
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

module.exports = { recordTask, listForPeriod, listForProject: listForPeriod, setHidden, summarizeByType };
