'use strict';

/**
 * projects/pageDecayDetector.js — детектор «затухающих» страниц.
 *
 * Идея: страница, у которой был стабильный трафик и он системно падает
 * несколько недель подряд, — самый ROI-эффективный класс задач (контент-
 * рефреш одной страницы часто возвращает 30–80% потерянного трафика).
 *
 * Алгоритм:
 *   1. Берём топ-N страниц по показам за период (вход — массив записей
 *      {page,date,clicks,impressions,ctr,position}).
 *   2. Группируем по странице → ряд по неделям (понедельник-воскресенье ISO).
 *   3. На ряду с минимум `minWeeks` точками считаем нормированную линейную
 *      регрессию clicks по индексу недели; slope в долях средних кликов
 *      в неделю.
 *   4. Помечаем decay: slope ≤ slopeThreshold (например, -0.05 = -5% в нед).
 *
 * Без сети и LLM. Не бросает.
 */

function _round(n, p = 4) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/** ISO-неделя начала: понедельник, формат YYYY-MM-DD (UTC). */
function _isoWeekStart(dateStr) {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  // Сдвиг назад до понедельника (Mon=1, ..., Sun=0 → надо -6).
  const shift = (day === 0) ? 6 : (day - 1);
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/**
 * Регрессия clicks по индексу недели. Возвращает slope (в кликах/нед),
 * mean (среднее кликов/нед), intercept, n (число недель), а также
 * нормированный slope = slope / max(mean, 1) — доля средних кликов/нед.
 */
function linearRegression(weekly) {
  const n = weekly.length;
  if (n < 2) return { n, slope: 0, intercept: 0, mean: 0, slope_norm: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += weekly[i].clicks;
    sumXY += i * weekly[i].clicks;
    sumXX += i * i;
  }
  const denom = (n * sumXX) - (sumX * sumX);
  const slope = denom ? ((n * sumXY) - (sumX * sumY)) / denom : 0;
  const mean = sumY / n;
  const intercept = mean - slope * (sumX / n);
  return {
    n,
    slope: _round(slope, 4),
    intercept: _round(intercept, 4),
    mean: _round(mean, 2),
    slope_norm: _round(slope / Math.max(mean, 1), 4),
  };
}

/**
 * Группирует записи page×date в недельные ряды.
 * @param {Array} rows — [{page,date,clicks,impressions,...}]
 * @returns {Map<page, Array<{week, clicks, impressions}>>}
 */
function groupByPageWeek(rows) {
  const byPage = new Map();
  for (const r of (rows || [])) {
    if (!r || !r.page || !r.date) continue;
    const week = _isoWeekStart(r.date);
    if (!week) continue;
    let bucket = byPage.get(r.page);
    if (!bucket) {
      bucket = new Map();
      byPage.set(r.page, bucket);
    }
    const existing = bucket.get(week) || { week, clicks: 0, impressions: 0 };
    existing.clicks      += Number(r.clicks)      || 0;
    existing.impressions += Number(r.impressions) || 0;
    bucket.set(week, existing);
  }
  // Превращаем Map недель в отсортированный массив.
  const out = new Map();
  for (const [page, bucket] of byPage.entries()) {
    const arr = [...bucket.values()].sort((a, b) => a.week.localeCompare(b.week));
    out.set(page, arr);
  }
  return out;
}

/**
 * Полный отчёт детектора. Принимает ряд page×date и конфиг.
 * @param {Array} pageDailyRows
 * @param {{minWeeks:number, slopeThreshold:number, minMeanWeeklyClicks:number, topPages:number}} cfg
 */
function detectPageDecay(pageDailyRows, cfg) {
  const c = cfg || {};
  const minWeeks = Math.max(2, Number(c.minWeeks) || 4);
  const threshold = Number(c.slopeThreshold);
  const minMean = Math.max(0, Number(c.minMeanWeeklyClicks) || 0);
  const topN = Math.max(1, Number(c.topPages) || 30);

  const grouped = groupByPageWeek(pageDailyRows);
  const items = [];
  for (const [page, weekly] of grouped.entries()) {
    if (weekly.length < minWeeks) continue;
    const reg = linearRegression(weekly);
    if (reg.mean < minMean) continue;
    const decaying = Number.isFinite(threshold) && reg.slope_norm <= threshold;
    items.push({
      page,
      weeks: weekly.length,
      first_week: weekly[0].week,
      last_week: weekly[weekly.length - 1].week,
      mean_weekly_clicks: reg.mean,
      slope_clicks_per_week: reg.slope,
      slope_norm: reg.slope_norm,
      total_clicks: weekly.reduce((s, w) => s + w.clicks, 0),
      decaying,
    });
  }
  // Сортируем: декай — сначала самый сильный (минимальный slope_norm), затем
  // остальные по mean clicks убыв.
  items.sort((a, b) => {
    if (a.decaying !== b.decaying) return a.decaying ? -1 : 1;
    if (a.decaying && b.decaying) return a.slope_norm - b.slope_norm;
    return b.mean_weekly_clicks - a.mean_weekly_clicks;
  });
  const top = items.slice(0, topN);
  return {
    available: items.length > 0,
    pages_analyzed: items.length,
    decaying_count: items.filter((i) => i.decaying).length,
    items: top,
  };
}

module.exports = {
  _isoWeekStart,
  linearRegression,
  groupByPageWeek,
  detectPageDecay,
};
