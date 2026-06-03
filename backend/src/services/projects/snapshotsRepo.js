'use strict';

/**
 * projects/snapshotsRepo.js — хранилище снимков GSC (project_snapshots).
 *
 * Снимок — «голая» выгрузка GSC за конкретный диапазон дат, отделённая от
 * LLM-анализа. Используется тремя сценариями:
 *   1. Сбор без LLM (POST /:id/snapshots) — быстрый снимок для дашборда.
 *   2. Хранилище для analysisRunner — каждый анализ ссылается на snapshot_id.
 *   3. История и сравнение «снимок vs снимок» (compareSnapshots).
 *
 * Структура колонки gsc_data совпадает с тем, что analysisRunner кладёт
 * сейчас в project_analyses.gsc_snapshot:
 *   { range, totals, series, top_queries, top_pages, commercial,
 *     serp_verification, breakdowns, period_compare, page_decay, brand_split }
 *
 * Все функции принимают `db` извне, чтобы оставаться легко тестируемыми.
 */

const dbDefault = require('../../config/db');

const ALLOWED_SOURCES = ['analysis', 'manual', 'backfill'];

function _normalizeSource(s) {
  return ALLOWED_SOURCES.includes(s) ? s : 'manual';
}

/**
 * Записать новый снимок.
 * @param {{projectId,userId,rangeKey,periodFrom,periodTo,source,gscData}} input
 * @returns {Promise<{id:string,created_at:string}>}
 */
async function insertSnapshot(input, db = dbDefault) {
  const periodFrom = input.periodFrom;
  const periodTo = input.periodTo;
  if (!periodFrom || !periodTo) {
    throw new Error('insertSnapshot: periodFrom/periodTo обязательны');
  }
  if (!input.gscData || typeof input.gscData !== 'object') {
    throw new Error('insertSnapshot: gscData обязателен');
  }
  const { rows } = await db.query(
    `INSERT INTO project_snapshots
       (project_id, user_id, range_key, period_from, period_to, source, gsc_data)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [
      input.projectId,
      input.userId,
      input.rangeKey || null,
      periodFrom,
      periodTo,
      _normalizeSource(input.source),
      JSON.stringify(input.gscData),
    ],
  );
  return rows[0];
}

/**
 * Список снимков проекта (без тяжёлого gsc_data — только метаданные).
 */
async function listSnapshots(projectId, opts = {}, db = dbDefault) {
  const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
  const { rows } = await db.query(
    `SELECT id, range_key, period_from, period_to, source, created_at,
            (gsc_data->'totals'->>'clicks')::int       AS clicks,
            (gsc_data->'totals'->>'impressions')::int  AS impressions,
            (gsc_data->'totals'->>'ctr')::numeric      AS ctr,
            (gsc_data->'totals'->>'position')::numeric AS position
       FROM project_snapshots
      WHERE project_id = $1
      ORDER BY period_to DESC, created_at DESC
      LIMIT $2`,
    [projectId, limit],
  );
  return rows;
}

/**
 * Полный снимок (с gsc_data). Возвращает null, если не найден или не
 * принадлежит этому пользователю.
 */
async function getSnapshot(snapshotId, projectId, userId, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT s.id, s.project_id, s.user_id, s.range_key, s.period_from,
            s.period_to, s.source, s.gsc_data, s.created_at
       FROM project_snapshots s
       JOIN projects p ON p.id = s.project_id
      WHERE s.id = $1 AND s.project_id = $2 AND p.user_id = $3`,
    [snapshotId, projectId, userId],
  );
  return rows[0] || null;
}

/**
 * Предыдущий по дате снимок того же проекта (для авто-сравнения дельты).
 */
async function findPreviousSnapshot(projectId, currentId, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT id, period_from, period_to, gsc_data, created_at
       FROM project_snapshots
      WHERE project_id = $1
        AND id <> $2
        AND period_to <= (SELECT period_to FROM project_snapshots WHERE id = $2)
      ORDER BY period_to DESC, created_at DESC
      LIMIT 1`,
    [projectId, currentId],
  );
  return rows[0] || null;
}

module.exports = {
  insertSnapshot,
  listSnapshots,
  getSnapshot,
  findPreviousSnapshot,
  ALLOWED_SOURCES,
};
