'use strict';

/**
 * categoryLead/intentClustering.js — [B] СБОР ИНТЕНТОВ.
 *
 * Превращает выгрузку поисковых запросов страницы (GSC query×page или ручной
 * список) в компактные кластеры интентов для Прохода 1 (Lead-text).
 *
 * Логика повторяет ручной приём из постановки:
 *   «сортирую запросы по ПОКАЗАМ (а не кликам), беру максимум показов,
 *    затем группирую по интентам и при необходимости расширяю».
 *
 * Классификация интента переиспользует projects/commercialIntent.classifyQuery
 * (transactional / commercial / investigation / informational / navigational /
 * other) — без дублирования словарей.
 */

const { classifyQuery } = require('../projects/commercialIntent');
const { getCategoryLeadConfig } = require('./config');

// Человекочитаемые названия кластеров для промпта.
const INTENT_LABELS = {
  transactional:  'Покупка / заказ (transactional)',
  commercial:     'Коммерческий выбор (commercial)',
  investigation:  'Сравнение / исследование (investigation)',
  informational:  'Информационные вопросы (informational)',
  navigational:   'Навигация / бренд (navigational)',
  other:          'Прочее',
};

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Нормализует разнородные строки выгрузки к {query, impressions, clicks}.
 * Принимает строки GSC (impressions/clicks/ctr/position) и ручные строки.
 */
function normalizeQueryRows(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (r == null) continue;
    if (typeof r === 'string') {
      const q = r.trim();
      if (q) out.push({ query: q, impressions: 0, clicks: 0 });
      continue;
    }
    const q = String(r.query || r.keyword || r.phrase || '').trim();
    if (!q) continue;
    out.push({
      query: q,
      impressions: _num(r.impressions ?? r.shows ?? r.impr),
      clicks: _num(r.clicks),
    });
  }
  return out;
}

/**
 * clusterIntents — главный вход [B].
 *
 * @param {Array}  queryRows — GSC-строки или ручные строки (см. normalizeQueryRows)
 * @param {object} [opts]
 * @param {string[]} [opts.brandTokens] — бренд-токены для пометки branded-запросов
 * @returns {object} { clusters:[{intent,label,total_impressions,total_clicks,
 *                       queries_count,sample_queries}], total_queries, source_top_n }
 */
function clusterIntents(queryRows, opts = {}) {
  const cfg = getCategoryLeadConfig().intents;
  const brandTokens = Array.isArray(opts.brandTokens) ? opts.brandTokens : [];

  const normalized = normalizeQueryRows(queryRows);

  // Сортировка по ПОКАЗАМ убыв.; при равенстве — по кликам. Запросы без
  // показов (ручной ввод) сохраняют исходный порядок в хвосте.
  const sorted = normalized
    .map((r, i) => ({ ...r, _i: i }))
    .sort((a, b) => (b.impressions - a.impressions)
      || (b.clicks - a.clicks)
      || (a._i - b._i));

  const top = sorted.slice(0, cfg.topByImpressions);

  // Группировка по интенту.
  const buckets = new Map(); // intent → { total_impressions, total_clicks, queries:[] }
  for (const r of top) {
    const { intent } = classifyQuery(r.query, { brandTokens });
    if (!buckets.has(intent)) {
      buckets.set(intent, { intent, total_impressions: 0, total_clicks: 0, queries: [] });
    }
    const b = buckets.get(intent);
    b.total_impressions += r.impressions;
    b.total_clicks += r.clicks;
    b.queries.push(r.query);
  }

  let clusters = [...buckets.values()]
    .filter((b) => b.queries.length >= cfg.minClusterSize)
    .sort((a, b) => (b.total_impressions - a.total_impressions)
      || (b.queries.length - a.queries.length))
    .slice(0, cfg.maxClusters)
    .map((b) => ({
      intent: b.intent,
      label: INTENT_LABELS[b.intent] || b.intent,
      total_impressions: b.total_impressions,
      total_clicks: b.total_clicks,
      queries_count: b.queries.length,
      sample_queries: b.queries.slice(0, cfg.sampleQueriesPerCluster),
    }));

  return {
    clusters,
    total_queries: normalized.length,
    source_top_n: top.length,
  };
}

/**
 * renderIntentsForPrompt — компактная текстовка кластеров для подстановки
 * в [ВОПРОСЫ_ПОКУПАТЕЛЕЙ] Прохода 1. Объединяет авто-кластеры и ручные
 * вопросы в единый список «болей/интентов».
 */
function renderIntentsForPrompt(clusterResult, manualQuestions = []) {
  const lines = [];
  const clusters = clusterResult && Array.isArray(clusterResult.clusters)
    ? clusterResult.clusters : [];
  for (const c of clusters) {
    const samples = (c.sample_queries || []).join('; ');
    const impr = c.total_impressions ? ` (показы: ${c.total_impressions})` : '';
    lines.push(`- [${c.label}]${impr}: ${samples}`);
  }
  for (const q of (manualQuestions || [])) {
    const s = String(q || '').trim();
    if (s) lines.push(`- [вопрос покупателя]: ${s}`);
  }
  return lines.join('\n') || '(интенты не заданы)';
}

module.exports = {
  clusterIntents,
  normalizeQueryRows,
  renderIntentsForPrompt,
  INTENT_LABELS,
};
