'use strict';

/**
 * eatAnalyzer/index — оркестратор оценки E-E-A-T по шаблонам страниц (п.5 ТЗ).
 *
 * Использует парсер (parser/scraper) для сбора HTML представителей каждого
 * кластера шаблонов, blockDetector — для разбора блоков, eatScorer — для
 * детерминированной оценки. Результат кладётся в snapshot.eat и используется
 * как вход schemaAuditor (microdata) и geoAeo (schema-покрытие).
 *
 * Graceful: парсинг поштучный, ошибка одной страницы не валит срез.
 */

const { getProjectsConfig } = require('../config');
const { classifyTemplates } = require('./templateClassifier');
const { detectBlocks } = require('./blockDetector');
const { scoreEat, scoreLabel } = require('./eatScorer');

/**
 * @param {object} args { project, snapshot, linkedUrls?:Set<string> }
 *   linkedUrls — множество URL, у которых есть бэклинки (из linkAudit), чтобы
 *   учесть Authoritativeness. Опционально.
 * @returns {Promise<{available:boolean, templates:Array}|null>}
 */
async function analyzeEat({ snapshot, linkedUrls } = {}) {
  const cfg = getProjectsConfig().eat;
  if (!cfg || !cfg.enabled) return null;
  const topPages = (snapshot && snapshot.top_pages) || [];
  if (topPages.length === 0) return { available: false, reason: 'no_pages' };

  const { clusters } = classifyTemplates(topPages, cfg);
  if (clusters.length === 0) return { available: false, reason: 'no_clusters' };

  const { scrapeUrl } = require('../../parser/scraper');
  const linked = linkedUrls instanceof Set ? linkedUrls : new Set();
  const templates = [];
  const scans = []; // транзитные hiddenLayers для schemaAuditor (не персистим)

  for (const cluster of clusters) {
    const rep = cluster.representatives[0];
    if (!rep) continue;
    try {
      const scraped = await scrapeUrl(rep.url, cfg.scrapeTimeoutMs);
      const detected = detectBlocks({
        markdown: scraped.markdown,
        title: scraped.title,
        hiddenLayers: scraped.hiddenLayers,
        chrome: scraped.chrome,
      });
      const hasBacklinks = linked.has(rep.url);
      const eat = scoreEat(detected, { hasBacklinks, template: cluster.template });
      templates.push({
        template: cluster.template,
        sample_url: rep.url,
        pages_in_cluster: cluster.total,
        score: eat.score,
        level: scoreLabel(eat.score),
        dimensions: eat.dimensions,
        gaps: eat.gaps,
        strengths: eat.strengths,
        blocks: detected.blocks,
        schema_types: detected.schema_types,
      });
      scans.push({ template: cluster.template, sample_url: rep.url, hiddenLayers: scraped.hiddenLayers || null });
    } catch (_) {
      templates.push({ template: cluster.template, sample_url: rep.url, error: 'scrape_failed' });
    }
  }

  const scored = templates.filter((t) => typeof t.score === 'number');
  const avgScore = scored.length
    ? Math.round(scored.reduce((s, t) => s + t.score, 0) / scored.length)
    : null;

  // _scans — транзитные данные для schema/geo слоёв, не кладутся в snapshot.
  return { available: true, templates, avg_score: avgScore, _scans: scans };
}

module.exports = {
  analyzeEat,
  // реэкспорт детерминированных слоёв для тестов/повторного использования
  classifyTemplates,
  detectBlocks,
  scoreEat,
  scoreLabel,
};
