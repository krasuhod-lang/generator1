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
} = require('./contentProfiler');

/**
 * @param {object} args { project, snapshot, queryPage }
 * @returns {Promise<{available:boolean, pages?:Array, patterns?:object,
 *   recommendations?:string[]}|null>}
 */
async function analyzeTopPages({ snapshot, queryPage } = {}) {
  const cfg = getProjectsConfig().topPageInsights;
  if (!cfg || !cfg.enabled) return null;

  const topPages = (snapshot && snapshot.top_pages) || [];
  const selected = selectTopPages(topPages, cfg);
  if (selected.length === 0) return { available: false, reason: 'no_top_pages' };

  const { scrapeUrl } = require('../../parser/scraper');

  const pages = [];
  for (const sel of selected) {
    const queries = queriesForPage(queryPage, sel.url, cfg.queriesPerPage || 12);
    try {
      const scraped = await scrapeUrl(sel.url, cfg.scrapeTimeoutMs);
      const profile = profileContent(scraped.markdown, scraped.title);
      const coverage = computeQueryCoverage(scraped.markdown, queries);
      const entry = {
        url: sel.url,
        impressions: sel.impressions,
        position: sel.position,
        ctr: sel.ctr,
        clicks: sel.clicks,
        title: scraped.title || '',
        queries,
        profile,
        coverage,
      };
      entry.ranking_factors = explainRanking(entry);
      pages.push(entry);
    } catch (_) {
      pages.push({
        url: sel.url,
        impressions: sel.impressions,
        position: sel.position,
        queries,
        error: 'scrape_failed',
      });
    }
  }

  const patterns = aggregatePatterns(pages);
  const recommendations = buildRecommendations(patterns, cfg);

  return {
    available: true,
    pages,
    patterns,
    recommendations,
  };
}

module.exports = {
  analyzeTopPages,
  // реэкспорт детерминированных слоёв для тестов/повторного использования
  selectTopPages,
  profileContent,
  computeQueryCoverage,
  aggregatePatterns,
  buildRecommendations,
  explainRanking,
};
