'use strict';

/**
 * contentGapPlanner/index — оркестратор плана публикаций в блог (п.3 ТЗ).
 * detectGaps → generateTopics (≥5). Graceful: ошибка → null.
 */

const { getProjectsConfig } = require('../config');
const { detectGaps } = require('./gapDetector');
const { generateTopics } = require('./topicGenerator');

/**
 * @param {object} args { project, topQueries, queryPage, breakdowns, brandTokens,
 *   serpVerification, llmFn, dspyClient }
 * @returns {Promise<object|null>} snapshot.blog_plan
 */
async function buildBlogPlan({ project, topQueries, queryPage, breakdowns, brandTokens,
  serpVerification, llmFn, dspyClient } = {}) {
  const cfg = getProjectsConfig().blogTopics;
  if (!cfg || !cfg.enabled) return null;
  try {
    const { gaps, signals } = detectGaps({
      topQueries, queryPage, breakdowns, brandTokens, serpVerification,
    });
    const res = await generateTopics({ gaps, signals, project, brandTokens, llmFn, dspyClient });
    if (!res) return null;
    return {
      available: true,
      topics: res.topics,
      topics_count: res.count,
      gap_signals: signals,
      insufficient: res.insufficient || null,
    };
  } catch (err) {
    return { available: false, error: String((err && err.message) || err) };
  }
}

module.exports = { buildBlogPlan };
