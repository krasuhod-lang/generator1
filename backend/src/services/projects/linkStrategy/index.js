'use strict';

/**
 * linkStrategy/index — оркестратор ссылочного слоя (п.1 и п.2 ТЗ).
 * Грузит импортированные ссылочные данные → аудит → рекомендации (≥5).
 * Graceful: при любой ошибке возвращает null, пайплайн не падает.
 */

const { getProjectsConfig } = require('../config');
const { loadLinks } = require('./linksRepo');
const { auditLinks } = require('./linkAuditor');
const { recommendLinks } = require('./linkRecommender');
const { enrichDonorTopics } = require('./donorTopicGenerator');

/**
 * @param {object} args { project, commercial, topPages, queryPage, db, llmFn }
 * @returns {Promise<object|null>} snapshot.link_audit
 */
async function buildLinkStrategy({ project, commercial, topPages, queryPage, db, llmFn } = {}) {
  const cfg = getProjectsConfig().linkStrategy;
  if (!cfg || !cfg.enabled) return null;
  try {
    const links = project && project.id ? await loadLinks(project.id, db) : { anchors: [], pages: [], sites: [] };
    const audit = auditLinks({ project, links, topPages }) || { available: false };
    const recommend = recommendLinks({ project, commercial, linkAudit: audit, topPages, queryPage });
    // Обогащаем рекомендации готовыми темами статей-доноров под анкор (инструмент
    // «Темы статей»). Graceful: при выключенном/упавшем LLM-слое donor_topic
    // остаётся детерминированной обёрткой.
    let donorTopics = null;
    try {
      donorTopics = await enrichDonorTopics({
        recommendations: recommend.recommendations, project, llmFn,
      });
    } catch (_) { donorTopics = null; }
    return {
      available: true,
      data_source: audit.data_source,
      has_link_data: !!audit.has_link_data,
      audit,
      recommendations: recommend.recommendations,
      recommendations_count: recommend.count,
      donor_topics: donorTopics,
    };
  } catch (err) {
    return { available: false, error: String(err && err.message || err) };
  }
}

module.exports = { buildLinkStrategy };
