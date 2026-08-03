'use strict';

/**
 * contentGapPlanner/gapDetector — детерминированный поиск контентных «дыр» под
 * план статей блога (п.3 ТЗ). Источники сигналов:
 *   • информационные запросы в striking distance (поз. 8..30) — есть спрос, нет
 *     сильной страницы;
 *   • query-page mismatch: инфо-запрос приземляется на коммерческую страницу
 *     (нужна отдельная статья) и наоборот;
 *   • гео-спрос из breakdowns.country без локализованного контента;
 *   • PAA/связанные темы из serpVerification (если есть).
 *
 * АНТИ-ДУБЛИ: кандидат отбрасывается, если тема уже закрыта страницей сайта
 * (запрос приземляется на инфо-страницу либо заголовок/слаг существующей
 * статьи почти совпадает с темой). Такие кандидаты не теряются — они уходят в
 * `covered` как «обновить существующую страницу», а не «написать новую».
 * Без сети. Возвращает список «сырых» тем-кандидатов для topicGenerator.
 */

const { getProjectsConfig } = require('../config');
const { classifyQuery } = require('../commercialIntent');
const { buildExistingContentIndex } = require('./existingContent');

function _norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').trim(); }

const INFO_INTENTS = ['informational', 'navigational'];

function _isInfo(query, brandTokens) {
  const c = classifyQuery(query, { brandTokens });
  return INFO_INTENTS.includes(c.intent) && !c.commercial;
}

/**
 * @param {object} args { topQueries:[], queryPage:[], breakdowns, brandTokens, serpVerification,
 *   topPages:[], pageMetaAudit, siteCrawlPages:[] }
 * @returns {{gaps:Array, covered:Array, signals:object}}
 */
function detectGaps({
  topQueries = [], queryPage = [], breakdowns = null, brandTokens = [], serpVerification = null,
  topPages = [], pageMetaAudit = null, siteCrawlPages = [],
} = {}) {
  const cfg = getProjectsConfig().blogTopics;
  const sd = (cfg && cfg.strikingDistance) || { minPosition: 5, maxPosition: 30, minImpressions: 20 };
  const dedupCfg = (cfg && cfg.dedup) || {};
  const dedupEnabled = dedupCfg.enabled !== false;
  const minSimilarity = Number(dedupCfg.existingPageSimilarity) || 0.6;

  // Индекс «что уже есть на сайте» — чтобы не плодить дубли тематик.
  const existing = buildExistingContentIndex({ queryPage, topPages, pageMetaAudit, siteCrawlPages });

  const gaps = [];
  const covered = [];
  const seen = new Set();
  const add = (query, reason, extra = {}) => {
    const k = _norm(query);
    if (!k || seen.has(k)) return;
    seen.add(k);
    const item = { query, reason, impressions: extra.impressions || 0, position: extra.position || null };
    // Тема уже закрыта существующей страницей → не новая статья, а доработка.
    const coverage = dedupEnabled ? existing.findCoverage(query, { minSimilarity }) : null;
    if (coverage) {
      covered.push({
        ...item,
        existing_url: coverage.url,
        existing_title: coverage.title || '',
        match: coverage.match,
        similarity: Number(coverage.score.toFixed(3)),
        recommendation: coverage.match === 'landing'
          ? 'Тема уже закрыта страницей сайта — обновить и усилить существующий материал, новую статью не создавать'
          : 'На сайте есть близкая по теме страница — расширить её вместо новой статьи (иначе дубль тематики)',
      });
      return;
    }
    gaps.push(item);
  };

  // 1) Информационные запросы в striking distance.
  (topQueries || []).forEach((r) => {
    const q = r.key || r.query;
    const pos = Number(r.position) || 0;
    const imp = Number(r.impressions) || 0;
    if (pos >= sd.minPosition && pos <= sd.maxPosition && imp >= sd.minImpressions && _isInfo(q, brandTokens)) {
      add(q, 'striking_info', { impressions: imp, position: pos });
    }
  });

  // 2) Query-page mismatch: инфо-запрос на коммерческой странице.
  (queryPage || []).forEach((r) => {
    const q = r.query || r.key;
    const page = r.page || '';
    if (!q || !page) return;
    const isCommercePage = /\/(catalog|product|tovar|shop|cart|uslugi|price|cena)\b/i.test(page);
    if (isCommercePage && _isInfo(q, brandTokens)) {
      add(q, 'info_query_on_commerce_page', { impressions: Number(r.impressions) || 0, position: Number(r.position) || null });
    }
  });

  // 3) Гео-спрос: страны со значимыми показами помимо основного гео.
  const geoSignals = [];
  if (breakdowns && Array.isArray(breakdowns.country)) {
    const sorted = breakdowns.country.slice().sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
    sorted.slice(1, 4).forEach((c) => {
      if ((c.impressions || 0) >= (cfg.geoMinImpressions || 100)) {
        geoSignals.push({ country: c.key || c.country, impressions: c.impressions });
      }
    });
  }

  // 4) Связанные темы из serpVerification (PAA / соседние интенты).
  const paa = [];
  if (serpVerification && Array.isArray(serpVerification.cases)) {
    serpVerification.cases.forEach((cse) => {
      (cse.related_queries || cse.paa || []).forEach((p) => { if (p) paa.push(p); });
    });
  }
  paa.slice(0, 10).forEach((p) => add(p, 'paa_related'));

  gaps.sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  covered.sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
  return {
    gaps: gaps.slice(0, (cfg.maxGapCandidates || 40)),
    covered: covered.slice(0, (cfg.maxGapCandidates || 40)),
    signals: {
      geo: geoSignals,
      paa_count: paa.length,
      existing_pages_indexed: existing.size,
      existing_info_pages: existing.info_pages_count,
      skipped_already_covered: covered.length,
    },
  };
}

module.exports = { detectGaps, _isInfo };
