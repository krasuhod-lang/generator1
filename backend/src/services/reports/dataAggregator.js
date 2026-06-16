'use strict';

/**
 * reports/dataAggregator.js — собирает все данные для черновика отчёта.
 *
 * Источники:
 *   • GSC      → projects/gscService.fetchPerformanceSeries (агрегируется по месяцам)
 *   • Я.ВМ     → projects/ydxService.fetchPerformanceSeries  (то же)
 *   • Keys.so  → keys_so_cache (loadCachedSeries / loadCurrent)
 *   • Tasks    → tasks_auto_log (listForPeriod / summarizeByType)
 *   • Forecast → forecastEngine.forecastMetric
 *
 * Не бросает целиком, если один источник недоступен — возвращает {error:...}
 * в соответствующей секции, остальные секции остаются валидными.
 */

const db = require('../../config/db');
const gscService = require('../projects/gscService');
const ydxService = require('../projects/ydxService');
const { loadCachedSeries, loadCurrent } = require('./keysSoSync');
const tasksLog = require('./tasksAutoLog');
const { forecastMetric } = require('./forecastEngine');

/**
 * Нормализует значение даты (строка или JS Date из node-postgres) в строку
 * формата YYYY-MM-DD. Колонки DATE драйвер pg отдаёт как объект Date, и
 * наивный `String(date).slice(0, 10)` давал «Wed Apr 01» вместо «2026-04-01»,
 * из-за чего GSC / Яндекс.Вебмастер / Keys.so отклоняли запрос (неверный формат
 * даты → ошибка GSC и HTTP 400 у Вебмастера).
 */
function _isoDate(value) {
  if (value == null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const s = String(value).trim();
  // Уже ISO-подобная строка («2026-04-01» или «2026-04-01T...»).
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Группировка дневной серии по месяцам. */
function _aggregateByMonth(series, valueKeys = ['clicks', 'impressions']) {
  const buckets = new Map();
  for (const row of series || []) {
    const date = String(row.date || '').slice(0, 10);
    if (!date) continue;
    const month = date.slice(0, 7); // YYYY-MM
    if (!buckets.has(month)) {
      const init = { date: `${month}-01`, _days: 0 };
      for (const k of valueKeys) init[k] = 0;
      // Для усреднения position/ctr храним веса.
      init._posSum = 0; init._posCnt = 0; init._ctrNum = 0;
      buckets.set(month, init);
    }
    const b = buckets.get(month);
    b._days++;
    for (const k of valueKeys) {
      if (typeof row[k] === 'number') b[k] += row[k];
    }
    if (typeof row.position === 'number' && row.position > 0) {
      b._posSum += row.position; b._posCnt++;
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((b) => {
      const out = { date: b.date };
      for (const k of valueKeys) out[k] = b[k];
      if (b._posCnt) out.position = Math.round((b._posSum / b._posCnt) * 100) / 100;
      if (typeof out.clicks === 'number' && typeof out.impressions === 'number' && out.impressions > 0) {
        out.ctr = Math.round((out.clicks / out.impressions) * 10000) / 100; // в %
      }
      return out;
    });
}

async function _gscSection(project, from, to) {
  if (!project.gsc_connected || !project.gsc_site_url) {
    return { connected: false, series: [], totals: null };
  }
  try {
    const data = await gscService.fetchPerformanceSeries(project, { from, to });
    const monthly = _aggregateByMonth(data.series, ['clicks', 'impressions']);
    return {
      connected: true,
      series: monthly,
      totals: data.totals || null,
      range: data.range,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'gsc_failed', series: [], totals: null };
  }
}

async function _ydxSection(project, from, to) {
  if (!project.ydx_connected || !project.ydx_site_url) {
    return { connected: false, series: [], totals: null };
  }
  try {
    const data = await ydxService.fetchPerformanceSeries(project, { from, to });
    const monthly = _aggregateByMonth(data.series, ['clicks', 'impressions']);
    return {
      connected: true,
      series: monthly,
      totals: data.totals || null,
      range: data.range,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'ydx_failed', series: [], totals: null };
  }
}

async function _keysSoSection(project, from, to) {
  if (!project.keys_so_domain) {
    return { connected: false, series: [], current: null };
  }
  try {
    const series = await loadCachedSeries(project.keys_so_domain, from, to);
    const current = await loadCurrent(project.keys_so_domain);
    return {
      connected: true,
      series: series.map((r) => ({
        date: r.date,
        visibility: r.visibility != null ? Number(r.visibility) : null,
        yandex_traffic: r.yandex_traffic,
        google_traffic: r.google_traffic,
        keywords_top1: r.keywords_top1,
        keywords_top3: r.keywords_top3,
        keywords_top10: r.keywords_top10,
        keywords_total: r.keywords_total,
      })),
      current: current
        ? {
            date: current.date,
            visibility: current.visibility != null ? Number(current.visibility) : null,
            top1: current.keywords_top1,
            top3: current.keywords_top3,
            top10: current.keywords_top10,
            total: current.keywords_total,
            yandex_traffic: current.yandex_traffic,
            google_traffic: current.google_traffic,
          }
        : null,
    };
  } catch (err) {
    return { connected: true, error: err.message || 'keys_so_failed', series: [], current: null };
  }
}

async function _tasksSection(projectId, from, to, opts = {}) {
  const includeHidden = opts.includeHidden === true;
  try {
    const [items, summary] = await Promise.all([
      tasksLog.listForPeriod(projectId, from, to, { includeHidden }),
      tasksLog.summarizeByType(projectId, from, to),
    ]);
    return { ...summary, items };
  } catch (err) {
    return { error: err.message || 'tasks_failed', total_generated: 0, by_type: {}, items: [] };
  }
}

function _buildForecast(gsc, keysSo) {
  const out = {};
  const gscClicks = (gsc.series || []).map((r) => Number(r.clicks) || 0);
  const visibility = (keysSo.series || [])
    .map((r) => (r.visibility != null ? Number(r.visibility) : null))
    .filter((v) => v != null);
  if (gscClicks.length >= 2) {
    out.gsc_clicks = forecastMetric(gscClicks, 3);
  }
  if (visibility.length >= 2) {
    out.keys_visibility = forecastMetric(visibility, 3);
  }
  return out;
}

/**
 * Главная функция. Загружает проект из БД и собирает агрегированный JSON.
 */
async function aggregateForDraft(draft, opts = {}) {
  const { rows } = await db.query(
    `SELECT * FROM projects WHERE id = $1`,
    [draft.project_id],
  );
  const project = rows[0];
  if (!project) throw new Error('project_not_found');

  const from = _isoDate(draft.date_from);
  const to = _isoDate(draft.date_to);

  const [gsc, ywm, keysSo, tasks] = await Promise.all([
    _gscSection(project, from, to),
    _ydxSection(project, from, to),
    _keysSoSection(project, from, to),
    _tasksSection(project.id, from, to, { includeHidden: opts.includeHidden }),
  ]);

  return {
    project: {
      id: project.id,
      name: project.name,
      url: project.url,
      logo_url: project.logo_url || null,
      color_accent: project.color_accent || null,
      keys_so_domain: project.keys_so_domain || null,
    },
    period: { from, to },
    gsc,
    ywm,
    keys_so: keysSo,
    tasks,
    forecast: _buildForecast(gsc, keysSo),
    generated_at: new Date().toISOString(),
  };
}

module.exports = { aggregateForDraft, _aggregateByMonth, _isoDate };
