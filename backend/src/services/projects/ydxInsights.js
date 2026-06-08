'use strict';

/**
 * projects/ydxInsights.js — расширяет базу анализируемых данных Яндекс.Вебмастера
 * детерминированными срезами поверх УЖЕ собранных топ-запросов (не требует
 * новых вызовов Webmaster API). Цель — дать аналитику Яндекса полную картину:
 *
 *   • position_buckets   — распределение спроса по позициям (топ-3 / 4-10 /
 *     11-30 / 30+) по показам и кликам;
 *   • striking_distance  — запросы у входа в топ (позиции 4-15) — быстрые точки
 *     роста, где небольшое усиление даёт максимум кликов;
 *   • low_ctr            — запросы с высокими показами и аномально низким CTR
 *     (поведенческий/сниппетный сигнал — важнейший фактор Яндекса);
 *   • intent_split       — коммерческий / информационный / прочий спрос
 *     (реиспользуем classifyQuery из commercialIntent).
 *
 * Всё считается из массива topQueries формата ydxService.fetchTopQueries:
 *   { key, clicks, impressions, ctr, position }.
 */

const { classifyQuery, deriveBrandTokens } = require('./commercialIntent');

function _num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function _round(n, p = 2) {
  const f = 10 ** p;
  return Math.round((Number(n) || 0) * f) / f;
}

/** Сводка показов/кликов и средневзвешенной позиции по набору запросов. */
function _aggregate(rows) {
  let clicks = 0;
  let impressions = 0;
  let posW = 0;
  let posN = 0;
  for (const r of rows) {
    const impr = _num(r.impressions);
    clicks += _num(r.clicks);
    impressions += impr;
    const pos = _num(r.position);
    if (pos > 0) { const w = impr || 1; posW += pos * w; posN += w; }
  }
  return {
    queries: rows.length,
    clicks,
    impressions,
    ctr: impressions ? _round((clicks / impressions) * 100, 2) : 0,
    avg_position: posN ? _round(posW / posN, 2) : 0,
  };
}

/** Распределение спроса по позиционным корзинам (по показам/кликам). */
function _positionBuckets(rows) {
  const defs = [
    { key: 'top3', label: 'Топ-3', test: (p) => p > 0 && p <= 3 },
    { key: 'top4_10', label: '4–10', test: (p) => p > 3 && p <= 10 },
    { key: 'pos11_30', label: '11–30', test: (p) => p > 10 && p <= 30 },
    { key: 'pos30plus', label: '30+', test: (p) => p > 30 },
  ];
  return defs.map((d) => {
    const bucket = rows.filter((r) => d.test(_num(r.position)));
    return { key: d.key, label: d.label, ...(_aggregate(bucket)) };
  });
}

/**
 * Запросы у входа в топ (позиции minPos..maxPos) с заметными показами —
 * сортируем по потенциалу (показы) и отдаём top N.
 */
function _strikingDistance(rows, { minPos, maxPos, minImpressions, limit }) {
  return rows
    .filter((r) => {
      const p = _num(r.position);
      return p >= minPos && p <= maxPos && _num(r.impressions) >= minImpressions;
    })
    .sort((a, b) => _num(b.impressions) - _num(a.impressions))
    .slice(0, limit)
    .map((r) => ({
      query: r.key,
      impressions: _num(r.impressions),
      clicks: _num(r.clicks),
      ctr: _num(r.ctr),
      position: _num(r.position),
    }));
}

/**
 * Аномально низкий CTR при высоких показах: запрос показывается, но по нему не
 * кликают — для Яндекса это прямой поведенческий минус (сниппет/заголовок/интент).
 * Берём запросы с показами ≥ minImpressions и CTR ниже порога для их позиции.
 */
function _lowCtr(rows, { minImpressions, maxPosition, ctrThreshold, limit }) {
  return rows
    .filter((r) => {
      const impr = _num(r.impressions);
      const pos = _num(r.position);
      const ctr = _num(r.ctr);
      return impr >= minImpressions && pos > 0 && pos <= maxPosition && ctr < ctrThreshold;
    })
    .sort((a, b) => _num(b.impressions) - _num(a.impressions))
    .slice(0, limit)
    .map((r) => ({
      query: r.key,
      impressions: _num(r.impressions),
      clicks: _num(r.clicks),
      ctr: _num(r.ctr),
      position: _num(r.position),
    }));
}

/** Коммерческий / информационный / навигационный / прочий спрос по показам. */
function _intentSplit(rows, brandTokens) {
  const groups = {
    commercial: [], informational: [], navigational: [], other: [],
  };
  for (const r of rows) {
    const cls = classifyQuery(r.key, { brandTokens });
    if (cls.commercial) groups.commercial.push(r);
    else if (cls.intent === 'informational' || cls.intent === 'investigation') groups.informational.push(r);
    else if (cls.intent === 'navigational') groups.navigational.push(r);
    else groups.other.push(r);
  }
  const out = {};
  Object.keys(groups).forEach((k) => { out[k] = _aggregate(groups[k]); });
  return out;
}

/**
 * @param {Array} topQueries  результат ydxService.fetchTopQueries
 * @param {object} [opts]
 * @param {object} [opts.project]      для деривации бренд-токенов
 * @param {Array}  [opts.brandTokens]  явные бренд-токены (приоритетнее project)
 * @param {object} [opts.config]       переопределение порогов
 * @returns {object|null}
 */
function buildYandexInsights(topQueries, opts = {}) {
  const rows = Array.isArray(topQueries) ? topQueries.filter((r) => r && r.key) : [];
  if (!rows.length) return { available: false, reason: 'no_queries' };

  const cfg = {
    striking: { minPos: 4, maxPos: 15, minImpressions: 10, limit: 25 },
    lowCtr: { minImpressions: 30, maxPosition: 10, ctrThreshold: 3, limit: 25 },
    ...(opts.config || {}),
  };

  let brandTokens = Array.isArray(opts.brandTokens) ? opts.brandTokens : null;
  if (!brandTokens && opts.project) {
    try {
      brandTokens = deriveBrandTokens({
        name: opts.project.name,
        siteUrl: opts.project.ydx_site_url,
        url: opts.project.url,
      });
    } catch (_) { brandTokens = []; }
  }
  brandTokens = brandTokens || [];

  return {
    available: true,
    total: _aggregate(rows),
    position_buckets: _positionBuckets(rows),
    striking_distance: _strikingDistance(rows, cfg.striking),
    low_ctr: _lowCtr(rows, cfg.lowCtr),
    intent_split: _intentSplit(rows, brandTokens),
  };
}

module.exports = { buildYandexInsights };
