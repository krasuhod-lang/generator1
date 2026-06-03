'use strict';

/**
 * projects/brandSplit.js — раздёление трафика на брендовый и небрендовый
 * по запросам. Использует brand-токены из commercialIntent.deriveBrandTokens.
 *
 * Алгоритм:
 *   1. Берём срез по запросам (query, clicks, impressions, ...) — большой
 *      список за период (rowLimit ≈ 5000), чтобы покрытие было репрезентативным.
 *   2. Классифицируем каждый запрос: branded, если query содержит хотя бы один
 *      brand-токен (нормализованное сравнение по подстроке).
 *   3. Считаем сумму clicks/impressions для бренда и для небренда, доли,
 *      средние CTR/позиции (взвешенные по показам).
 *
 * Без сети и LLM.
 */

function _norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[ё]/g, 'е').trim();
}

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * Помечает запросы как branded/non-branded и агрегирует пулы.
 * @param {Array<{key:string,clicks:number,impressions:number,ctr:number,position:number}>} queries
 * @param {string[]} brandTokens — токены бренда (нормализованные).
 */
function splitQueries(queries, brandTokens) {
  const tokens = (brandTokens || []).map(_norm).filter((t) => t.length >= 3);
  const branded = { clicks: 0, impressions: 0, queries: 0, ctr_w_sum: 0, pos_w_sum: 0 };
  const nonbranded = { clicks: 0, impressions: 0, queries: 0, ctr_w_sum: 0, pos_w_sum: 0 };
  const flagged = [];

  for (const q of (queries || [])) {
    if (!q || typeof q.key !== 'string') continue;
    const norm = _norm(q.key);
    const isBrand = tokens.some((t) => t && norm.includes(t));
    const bucket = isBrand ? branded : nonbranded;
    bucket.clicks      += Number(q.clicks)      || 0;
    bucket.impressions += Number(q.impressions) || 0;
    bucket.queries     += 1;
    bucket.ctr_w_sum   += (Number(q.ctr)      || 0) * (Number(q.impressions) || 0);
    bucket.pos_w_sum   += (Number(q.position) || 0) * (Number(q.impressions) || 0);
    flagged.push({ key: q.key, branded: isBrand });
  }

  const totalClicks = branded.clicks + nonbranded.clicks;
  const totalImpr   = branded.impressions + nonbranded.impressions;

  function summarize(bucket) {
    const pctClicks = totalClicks ? _round((bucket.clicks / totalClicks) * 100, 2) : 0;
    const pctImpr   = totalImpr   ? _round((bucket.impressions / totalImpr) * 100, 2) : 0;
    const ctr_w  = bucket.impressions ? _round(bucket.ctr_w_sum / bucket.impressions, 2) : 0;
    const pos_w  = bucket.impressions ? _round(bucket.pos_w_sum / bucket.impressions, 2) : 0;
    return {
      queries: bucket.queries,
      clicks: bucket.clicks,
      impressions: bucket.impressions,
      ctr: ctr_w,
      position: pos_w,
      clicks_pct: pctClicks,
      impressions_pct: pctImpr,
    };
  }

  return {
    available: (queries || []).length > 0 && tokens.length > 0,
    brand_tokens: tokens,
    branded: summarize(branded),
    nonbranded: summarize(nonbranded),
    flagged_sample: flagged.slice(0, 50),
  };
}

module.exports = { splitQueries };
