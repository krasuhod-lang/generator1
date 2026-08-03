'use strict';

/**
 * contentGapPlanner/index — оркестратор плана публикаций в блог (п.3 ТЗ).
 * detectGaps → generateTopics (≥5). Graceful: ошибка → null.
 *
 * Анти-дубли: перед генерацией строится индекс существующего контента сайта
 * (topPages + query×page + распарсенные мета-теги + краул). Темы, уже закрытые
 * страницей сайта, не попадают в план новых статей — они уходят в
 * `already_covered` с рекомендацией доработать существующий материал.
 */

const { getProjectsConfig } = require('../config');
const { detectGaps } = require('./gapDetector');
const { generateTopics } = require('./topicGenerator');

/**
 * @param {object} args { project, topQueries, queryPage, breakdowns, brandTokens,
 *   serpVerification, topPages, pageMetaAudit, siteCrawlPages, llmFn, dspyClient }
 * @returns {Promise<object|null>} snapshot.blog_plan
 */
async function buildBlogPlan({ project, topQueries, queryPage, breakdowns, brandTokens,
  serpVerification, topPages, pageMetaAudit, siteCrawlPages, llmFn, dspyClient } = {}) {
  const cfg = getProjectsConfig().blogTopics;
  if (!cfg || !cfg.enabled) return null;
  try {
    const { gaps, covered, signals } = detectGaps({
      topQueries, queryPage, breakdowns, brandTokens, serpVerification,
      topPages, pageMetaAudit, siteCrawlPages,
    });
    const res = await generateTopics({ gaps, signals, project, brandTokens, llmFn, dspyClient });
    if (!res) return null;
    return {
      available: true,
      topics: res.topics,
      topics_count: res.count,
      gap_signals: res.signals || signals,
      already_covered: covered || [],
      already_covered_count: (covered || []).length,
      merged_duplicates: res.merged_duplicates || [],
      insufficient: res.insufficient || null,
    };
  } catch (err) {
    return { available: false, error: String((err && err.message) || err) };
  }
}

module.exports = { buildBlogPlan };
