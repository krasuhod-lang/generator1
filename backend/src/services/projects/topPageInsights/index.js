'use strict';

/**
 * topPageInsights/index — реверс-инжиниринг топовых страниц (п.3 ТЗ).
 *
 * Флоу:
 *   1. Детерминированно выбираем страницы-лидеры: высокие показы И высокая
 *      позиция в выдаче (contentProfiler.selectTopPages).
 *   2. Парсим контент каждой (parser/scraper — с retry/SSL) отдельным этапом.
 *   3. Профилируем контент (объём, структура, списки/таблицы/изображения) и
 *      считаем покрытие семантики GSC-запросов.
 *   4. Выводим закономерности «почему страница в топе» и формируем перечень
 *      рекомендаций для будущих статей (что влияет на позицию).
 *
 * Graceful: парсинг поштучный, ошибка одной страницы не валит срез. Тяжёлый
 * scraper подгружается лениво, детерминированные хелперы тестируются без сети.
 */

const { getProjectsConfig } = require('../config');
const {
  selectTopPages,
  queriesForPage,
  profileContent,
  computeQueryCoverage,
  aggregatePatterns,
  buildRecommendations,
  explainRanking,
  profileOverspam,
  aggregateOverspam,
  buildTopDifferential,
} = require('./contentProfiler');

/**
 * Выбирает «отстающий» набор сравнения: страницы с показами, но позицией хуже
 * топа (minPosition..maxPosition), исключая уже выбранные топ-URL.
 * @returns {Array<{url, impressions, position, ctr, clicks}>}
 */
function selectComparisonPages(topPages, cmpCfg, excludeUrls) {
  const minPosition = Number(cmpCfg.minPosition) || 11;
  const maxPosition = Number(cmpCfg.maxPosition) || 50;
  const minImpressions = Number(cmpCfg.minImpressions) || 0;
  const maxPages = Number(cmpCfg.maxPages) || 4;
  const exclude = excludeUrls instanceof Set ? excludeUrls : new Set();
  if (!Array.isArray(topPages)) return [];
  return topPages
    .filter((p) => p && p.key
      && !exclude.has(p.key)
      && (Number(p.impressions) || 0) >= minImpressions
      && Number(p.position) >= minPosition
      && Number(p.position) <= maxPosition)
    .slice()
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, maxPages)
    .map((p) => ({
      url: p.key,
      impressions: p.impressions || 0,
      position: p.position || 0,
      ctr: p.ctr || 0,
      clicks: p.clicks || 0,
    }));
}

/**
 * Парсит и профилирует одну страницу. Переспам (КФ6) считается ТОЛЬКО после
 * успешного парсинга контента. Ошибка → entry с error.
 */
async function _profilePage(scrapeUrl, sel, queries, cfg) {
  try {
    const scraped = await scrapeUrl(sel.url, cfg.scrapeTimeoutMs);
    const profile = profileContent(scraped.markdown, scraped.title);
    const coverage = computeQueryCoverage(scraped.markdown, queries);
    const overspam = profileOverspam(scraped.markdown, scraped.title, queries, cfg.overspam);
    return {
      url: sel.url,
      impressions: sel.impressions,
      position: sel.position,
      ctr: sel.ctr,
      clicks: sel.clicks,
      title: scraped.title || '',
      queries,
      profile,
      coverage,
      overspam,
    };
  } catch (_) {
    return {
      url: sel.url,
      impressions: sel.impressions,
      position: sel.position,
      queries,
      error: 'scrape_failed',
    };
  }
}

/**
 * @param {object} args { project, snapshot, queryPage }
 * @returns {Promise<{available:boolean, pages?:Array, patterns?:object,
 *   recommendations?:string[], overspam?:object, differential?:object}|null>}
 */
async function analyzeTopPages({ snapshot, queryPage } = {}) {
  const cfg = getProjectsConfig().topPageInsights;
  if (!cfg || !cfg.enabled) return null;

  const topPages = (snapshot && snapshot.top_pages) || [];
  const selected = selectTopPages(topPages, cfg);
  if (selected.length === 0) return { available: false, reason: 'no_top_pages' };

  const { scrapeUrl } = require('../../parser/scraper');

  // 1) Парсинг и профилирование страниц-лидеров (топ).
  const pages = [];
  const selectedUrls = new Set();
  for (const sel of selected) {
    selectedUrls.add(sel.url);
    const queries = queriesForPage(queryPage, sel.url, cfg.queriesPerPage || 12);
    const entry = await _profilePage(scrapeUrl, sel, queries, cfg);
    if (!entry.error) entry.ranking_factors = explainRanking(entry);
    pages.push(entry);
  }

  // 2) Набор сравнения: «отстающие» страницы (только после парсинга топа).
  let comparisonPages = [];
  const cmpCfg = cfg.comparison || {};
  if (cmpCfg.enabled) {
    const cmpSelected = selectComparisonPages(topPages, cmpCfg, selectedUrls);
    for (const sel of cmpSelected) {
      const queries = queriesForPage(queryPage, sel.url, cfg.queriesPerPage || 12);
      comparisonPages.push(await _profilePage(scrapeUrl, sel, queries, cfg));
    }
  }

  const patterns = aggregatePatterns(pages);
  const recommendations = buildRecommendations(patterns, cfg);
  const overspam = aggregateOverspam(pages.concat(comparisonPages));
  const differential = buildTopDifferential(pages, comparisonPages);

  return {
    available: true,
    pages,
    patterns,
    recommendations,
    overspam,
    differential,
    comparison_pages: comparisonPages,
  };
}

module.exports = {
  analyzeTopPages,
  // реэкспорт детерминированных слоёв для тестов/повторного использования
  selectTopPages,
  selectComparisonPages,
  profileContent,
  computeQueryCoverage,
  aggregatePatterns,
  buildRecommendations,
  explainRanking,
  profileOverspam,
  aggregateOverspam,
  buildTopDifferential,
};
