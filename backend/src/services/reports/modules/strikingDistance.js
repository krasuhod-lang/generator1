'use strict';

/**
 * reports/modules/strikingDistance.js — модуль «Striking Distance» (ТЗ §5.1).
 *
 * Запрос находится в зоне Striking Distance, если средняя позиция за период
 * входит в диапазон [striking_pos_min; striking_pos_max] (по умолчанию 11–20).
 *
 * Opportunity Score (ТЗ §5.1):
 *   opportunity_delta = impressions × ctr_bench_top10 − clicks
 *   opportunity_score = opportunity_delta × (volume / 1000)
 * где ctr_bench_top10 = 0.025 (benchmark CTR для позиции 10).
 *
 * Приоритеты по opportunity_score:
 *   🔴 High   (>= 500)
 *   🟡 Medium (200–499)
 *   🟢 Low    (< 200)
 *
 * Если объём (volume) запроса неизвестен, множитель volume/1000 заменяется на 1,
 * чтобы score деградировал к opportunity_delta, а не обнулялся.
 */

const { normalizeSettings } = require('./settings');

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _round(n, p = 2) {
  const f = 10 ** p;
  return Math.round((Number(n) || 0) * f) / f;
}

function priorityOf(score) {
  const s = _num(score);
  if (s >= 500) return 'high';
  if (s >= 200) return 'medium';
  return 'low';
}

/**
 * @param {Array<{query,url|page,clicks,impressions,position}>} rows  query×page срез
 * @param {object} opts
 * @param {object} opts.settings              пороги (striking_pos_min/max, ctr_benchmark_top10)
 * @param {Object<string,number>} opts.volumeByQuery  карта query → частотность (Keys.so)
 * @param {number} opts.limit                 ограничение размера выдачи (по умолчанию 50)
 */
function buildStrikingDistance(rows, opts = {}) {
  const settings = normalizeSettings(opts.settings);
  const volumeByQuery = opts.volumeByQuery || {};
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  const benchTop10 = settings.ctr_benchmark_top10;

  // Группировка по query+url с взвешиванием позиции по показам.
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const query = String(row.query || '').trim();
    const url = String(row.url || row.page || '').trim();
    if (!query) continue;
    const key = `${query}\u0000${url}`;
    if (!groups.has(key)) {
      groups.set(key, { query, url, clicks: 0, impressions: 0, _posSum: 0, _posWeight: 0 });
    }
    const g = groups.get(key);
    const clicks = _num(row.clicks);
    const impressions = _num(row.impressions);
    g.clicks += clicks;
    g.impressions += impressions;
    const pos = _num(row.position);
    if (pos > 0) {
      const weight = impressions || 1;
      g._posSum += pos * weight;
      g._posWeight += weight;
    }
  }

  const items = [];
  for (const g of groups.values()) {
    const avgPosition = g._posWeight > 0 ? g._posSum / g._posWeight : 0;
    if (avgPosition < settings.striking_pos_min || avgPosition > settings.striking_pos_max) continue;

    const volumeRaw = volumeByQuery[g.query];
    const hasVolume = Number.isFinite(Number(volumeRaw)) && Number(volumeRaw) > 0;
    const volume = hasVolume ? Number(volumeRaw) : 0;
    const opportunityDelta = g.impressions * benchTop10 - g.clicks;
    const multiplier = hasVolume ? volume / 1000 : 1;
    const opportunityScore = opportunityDelta * multiplier;

    items.push({
      query: g.query,
      url: g.url || null,
      avg_position: _round(avgPosition, 2),
      clicks: g.clicks,
      impressions: g.impressions,
      ctr: g.impressions > 0 ? _round((g.clicks / g.impressions) * 100, 2) : 0,
      volume: hasVolume ? volume : null,
      opportunity_delta: _round(opportunityDelta, 1),
      opportunity_score: _round(opportunityScore, 1),
      priority: priorityOf(opportunityScore),
    });
  }

  items.sort((a, b) => b.opportunity_score - a.opportunity_score);
  const limited = limit > 0 ? items.slice(0, limit) : items;

  const summary = { total: items.length, high: 0, medium: 0, low: 0, total_opportunity_clicks: 0 };
  for (const it of items) {
    summary[it.priority] += 1;
    if (it.opportunity_delta > 0) summary.total_opportunity_clicks += it.opportunity_delta;
  }
  summary.total_opportunity_clicks = Math.round(summary.total_opportunity_clicks);

  return { items: limited, summary, settings: { min: settings.striking_pos_min, max: settings.striking_pos_max } };
}

module.exports = { buildStrikingDistance, priorityOf };
