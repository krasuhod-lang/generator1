'use strict';

/**
 * reports/modules/ctrGap.js — детектор «CTR Gap» (ТЗ §5.2).
 *
 * Триггер срабатывает при выполнении ВСЕХ условий:
 *   • total_impressions >= settings.ctr_high_impressions (по умолчанию 500)
 *   • avg_position <= 15
 *   • actual_ctr < benchmark × 0.7
 *
 * Уровни алерта:
 *   🔴 Критический: actual_ctr < benchmark × 0.5
 *   🟡 Предупреждение: benchmark × 0.5 ≤ actual_ctr < benchmark × 0.7
 *
 * actual_ctr вычисляется как clicks/impressions (доля 0..1), benchmark берётся
 * из ctrBenchmarks по средней позиции и поисковику.
 */

const { getCtrBenchmark } = require('./ctrBenchmarks');
const { normalizeSettings } = require('./settings');

const MAX_POSITION = 15; // ТЗ §5.2: avg_position <= 15
const WARN_FACTOR = 0.7;
const CRIT_FACTOR = 0.5;

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _round(n, p = 2) { const f = 10 ** p; return Math.round((Number(n) || 0) * f) / f; }

/** actual_ctr как доля (0..1) из агрегированной строки. */
function _ctrFraction(g) {
  if (g.impressions > 0) return g.clicks / g.impressions;
  return 0;
}

/**
 * Чистое правило срабатывания CTR Gap для уже агрегированной строки
 * {impressions, position, ctr_fraction}.
 */
function isCtrGap(row, settings, engine = 'google') {
  const s = normalizeSettings(settings);
  const impressions = _num(row.impressions);
  const position = _num(row.position ?? row.avg_position);
  const ctr = _num(row.ctr_fraction ?? row.actual_ctr);
  if (impressions < s.ctr_high_impressions) return false;
  if (position <= 0 || position > MAX_POSITION) return false;
  const benchmark = getCtrBenchmark(position, engine);
  return ctr < benchmark * WARN_FACTOR;
}

/** Уровень алерта: 'critical' | 'warning' | null. */
function ctrGapLevel(ctr, benchmark) {
  const c = _num(ctr);
  const b = _num(benchmark);
  if (b <= 0) return null;
  if (c < b * CRIT_FACTOR) return 'critical';
  if (c < b * WARN_FACTOR) return 'warning';
  return null;
}

/**
 * Построить список CTR-разрывов из query×page среза.
 * @param {Array} rows {query,url|page,clicks,impressions,position}
 * @param {object} opts {settings, engine, limit}
 */
function buildCtrGaps(rows, opts = {}) {
  const settings = normalizeSettings(opts.settings);
  const engine = opts.engine || 'google';
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;

  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const query = String(row.query || '').trim();
    const url = String(row.url || row.page || '').trim();
    if (!query) continue;
    const key = `${query}\u0000${url}`;
    if (!groups.has(key)) groups.set(key, { query, url, clicks: 0, impressions: 0, _posSum: 0, _posWeight: 0 });
    const g = groups.get(key);
    const impressions = _num(row.impressions);
    g.clicks += _num(row.clicks);
    g.impressions += impressions;
    const pos = _num(row.position);
    if (pos > 0) { g._posSum += pos * (impressions || 1); g._posWeight += (impressions || 1); }
  }

  const items = [];
  for (const g of groups.values()) {
    g.position = g._posWeight > 0 ? g._posSum / g._posWeight : 0;
    const ctr = _ctrFraction(g);
    const benchmark = getCtrBenchmark(g.position, engine);
    const level = ctrGapLevel(ctr, benchmark);
    const passes = g.impressions >= settings.ctr_high_impressions
      && g.position > 0 && g.position <= MAX_POSITION
      && level != null;
    if (!passes) continue;
    items.push({
      query: g.query,
      url: g.url || null,
      position: _round(g.position, 2),
      impressions: g.impressions,
      clicks: g.clicks,
      ctr: _round(ctr * 100, 2),
      benchmark_ctr: _round(benchmark * 100, 2),
      ctr_ratio: benchmark > 0 ? _round(ctr / benchmark, 2) : null,
      level,
    });
  }

  // Сортируем по «глубине» провала (меньший ctr_ratio = хуже), показы как tie-break.
  items.sort((a, b) => (a.ctr_ratio - b.ctr_ratio) || (b.impressions - a.impressions));
  const limited = limit > 0 ? items.slice(0, limit) : items;

  const summary = { total: items.length, critical: 0, warning: 0, lost_clicks: 0 };
  for (const it of items) {
    summary[it.level] += 1;
    const lost = (it.benchmark_ctr / 100) * it.impressions - it.clicks;
    if (lost > 0) summary.lost_clicks += lost;
  }
  summary.lost_clicks = Math.round(summary.lost_clicks);

  return { items: limited, summary };
}

module.exports = { buildCtrGaps, isCtrGap, ctrGapLevel, MAX_POSITION };
