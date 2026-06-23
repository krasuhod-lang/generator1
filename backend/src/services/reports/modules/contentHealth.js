'use strict';

/**
 * reports/modules/contentHealth.js — Content Health Score (ТЗ §5.3)
 * и Position Trend через линейную регрессию (ТЗ §5.4).
 *
 * Content Health Score (0–100):
 *   score = 100
 *   −20  если is_ctr_gap
 *   −15  если position_delta_30d > 5      (деградация позиции)
 *   −10  если impressions_trend == 'declining_2m'
 *   −10  если images_no_alt_ratio > 0.3
 *   −5   если webp_ratio < 0.5
 * Статусы: 🟢 80–100 (healthy) | 🟡 50–79 (needs_work) | 🔴 0–49 (critical)
 */

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function _round(n, p = 3) { const f = 10 ** p; return Math.round((Number(n) || 0) * f) / f; }

function healthStatus(score) {
  const s = _num(score);
  if (s >= 80) return 'healthy';
  if (s >= 50) return 'needs_work';
  return 'critical';
}

/** Чистый расчёт Content Health Score из сигналов одной страницы. */
function contentHealthScore(urlData = {}) {
  let score = 100;
  if (urlData.is_ctr_gap) score -= 20;
  if (_num(urlData.position_delta_30d) > 5) score -= 15;
  if (urlData.impressions_trend === 'declining_2m') score -= 10;
  if (_num(urlData.images_no_alt_ratio) > 0.3) score -= 10;
  if (urlData.webp_ratio != null && _num(urlData.webp_ratio) < 0.5) score -= 5;
  return Math.max(0, score);
}

/**
 * Position Trend через линейную регрессию (ТЗ §5.4).
 * В SEO меньшая позиция = лучше: растущий slope = деградация.
 *   trend = 'growing'   если slope < -0.1  (позиция улучшается)
 *           'declining' если slope >  0.1  (позиция падает)
 *           'stable'    иначе
 * @param {number[]} positions хронологический ряд средних позиций
 */
function positionTrend(positions) {
  const xs = [];
  const ys = [];
  (Array.isArray(positions) ? positions : []).forEach((p) => {
    const v = Number(p);
    if (Number.isFinite(v)) { xs.push(xs.length); ys.push(v); }
  });
  const n = ys.length;
  if (n < 2) {
    return { slope: 0, trend: 'stable', delta_7d: null, delta_30d: null, points: n };
  }
  // slope методом наименьших квадратов (эквивалент np.polyfit deg=1).
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const trend = slope < -0.1 ? 'growing' : slope > 0.1 ? 'declining' : 'stable';
  const last = ys[n - 1];
  const delta7d = n >= 7 ? _round(last - ys[n - 7], 2) : null;
  const delta30d = n >= 30 ? _round(last - ys[n - 30], 2) : null;
  return { slope: _round(slope, 3), trend, delta_7d: delta7d, delta_30d: delta30d, points: n };
}

/**
 * Построить Content Health по карте страниц.
 * @param {Array<object>} urls массив сигналов страниц (url + поля urlData)
 * @param {object} opts {limit}
 */
function buildContentHealth(urls, opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : 50;
  const items = (Array.isArray(urls) ? urls : []).map((u) => {
    const score = contentHealthScore(u);
    return {
      url: u.url || null,
      score,
      status: healthStatus(score),
      is_ctr_gap: !!u.is_ctr_gap,
      position_delta_30d: u.position_delta_30d != null ? _round(u.position_delta_30d, 2) : null,
      impressions_trend: u.impressions_trend || null,
      images_no_alt_ratio: u.images_no_alt_ratio != null ? _round(u.images_no_alt_ratio, 3) : null,
      webp_ratio: u.webp_ratio != null ? _round(u.webp_ratio, 3) : null,
    };
  });
  items.sort((a, b) => a.score - b.score); // худшие сверху
  const limited = limit > 0 ? items.slice(0, limit) : items;

  const summary = { total: items.length, healthy: 0, needs_work: 0, critical: 0, avg_score: 0 };
  let sum = 0;
  for (const it of items) { summary[it.status] += 1; sum += it.score; }
  summary.avg_score = items.length ? Math.round(sum / items.length) : 0;

  return { items: limited, summary };
}

module.exports = { contentHealthScore, healthStatus, positionTrend, buildContentHealth };
