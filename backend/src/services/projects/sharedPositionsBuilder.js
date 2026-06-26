'use strict';

/**
 * sharedPositionsBuilder — формирует секцию `positions` для публичной
 * (share-link) ответ-секции проекта.
 *
 * Контракт:
 *   • если связанного position_projects нет — возвращает null,
 *   • в client-режиме скрываем технические поля (id связанного проекта,
 *     domain — он уже виден в URL SEO-проекта; tags ключей; внутренние
 *     timestamps), оставляем только числовые агрегаты и top-N таблицы запросов,
 *   • в analyst-режиме отдаём полный набор (для внутренних демо/презентаций),
 *   • количество строк таблицы запросов ограничено
 *     config.positions.sharedKeywordsLimit (по умолчанию 50) — публичная
 *     ссылка не должна сливать всю семантику конкурентам.
 *
 * Полностью read-only: никаких изменений в БД.
 */

const db = require('../../config/db');
const analytics = require('../positionTracker/analytics');
const { getProjectsConfig } = require('./config');
const { VIEW_MODES } = require('./viewMode');

function _sanitizeKeyword(row, mode) {
  const base = {
    query: row.query,
    position: row.position,
    found_url: row.found_url || null,
    prev_position: row.prev_position,
    delta: row.delta,
    direction: row.direction,
  };
  if (mode === VIEW_MODES.ANALYST) {
    return {
      ...base,
      keyword_id: row.keyword_id,
      target_url: row.target_url || null,
      tags: row.tags || [],
      engine: row.engine || null,
      checked_at: row.checked_at,
    };
  }
  return base;
}

function _sanitizeRun(run, mode) {
  if (!run) return null;
  const base = {
    status: run.status,
    engine: run.engine,
    keywords_total: run.keywords_total,
    keywords_done: run.keywords_done,
    started_at: run.started_at,
    finished_at: run.finished_at,
  };
  if (mode === VIEW_MODES.ANALYST) return { id: run.id, error: run.error, ...base };
  return base;
}

/**
 * @param {string} parentProjectId — projects.id (родитель)
 * @param {string} mode            — 'analyst' | 'client'
 * @param {object} [opts]
 * @param {string} [opts.period='week']
 * @returns {Promise<object|null>}
 */
async function buildSharedPositionsSection(parentProjectId, mode, opts = {}) {
  if (!parentProjectId) return null;
  const cfg = getProjectsConfig().positions;
  const period = String(opts.period || 'week');

  const { rows: linked } = await db.query(
    `SELECT id, engine::text AS engine, geo_lr, geo_loc, device::text AS device,
            schedule::text AS schedule, last_run_at
       FROM position_projects
      WHERE parent_project_id = $1
      LIMIT 1`,
    [parentProjectId],
  );
  if (!linked[0]) return null;
  const positionProjectId = linked[0].id;

  // Проверим, есть ли хотя бы один result — иначе секция бесполезна.
  const { rows: hasRows } = await db.query(
    `SELECT 1 FROM position_results WHERE project_id = $1 LIMIT 1`,
    [positionProjectId],
  );
  if (!hasRows.length) {
    return {
      enabled: true,
      has_data: false,
      settings: {
        engine: linked[0].engine,
        device: linked[0].device,
        geo_lr: linked[0].geo_lr || '',
        geo_loc: linked[0].geo_loc || '',
      },
    };
  }

  const [summary, series, topsDistribution, keywordsTable, runs] = await Promise.all([
    analytics.getProjectSummary(positionProjectId, { period }),
    analytics.getProjectSeries(positionProjectId, { granularity: cfg.seriesGranularity }),
    analytics.getTopsDistribution(positionProjectId, { period, buckets: cfg.topsBuckets }),
    analytics.getKeywordsTable(positionProjectId, { period }),
    db.query(
      `SELECT id, engine, status::text AS status, error,
              keywords_total, keywords_done, started_at, finished_at
         FROM position_runs
        WHERE project_id = $1
        ORDER BY started_at DESC
        LIMIT 1`,
      [positionProjectId],
    ),
  ]);

  const limit = Math.max(1, Number(cfg.sharedKeywordsLimit) || 50);
  // Сортируем таблицу по позиции (NULL в конец), берём top-N.
  const sorted = [...keywordsTable].sort((a, b) => {
    const pa = a.position == null ? 999 : a.position;
    const pb = b.position == null ? 999 : b.position;
    return pa - pb;
  }).slice(0, limit);

  const result = {
    enabled: true,
    has_data: true,
    period,
    settings: {
      engine: linked[0].engine,
      device: linked[0].device,
      geo_lr: linked[0].geo_lr || '',
      geo_loc: linked[0].geo_loc || '',
    },
    summary,
    series,
    tops_distribution: topsDistribution,
    keywords_table: sorted.map((r) => _sanitizeKeyword(r, mode)),
    keywords_truncated: keywordsTable.length > limit
      ? { shown: limit, total: keywordsTable.length }
      : null,
    last_run: _sanitizeRun(runs.rows[0], mode),
  };
  if (mode === VIEW_MODES.ANALYST) {
    result.position_project_id = positionProjectId;
  }
  return result;
}

module.exports = { buildSharedPositionsSection };
