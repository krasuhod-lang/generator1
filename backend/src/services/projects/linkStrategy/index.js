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

/**
 * @param {object} args { project, commercial, topPages, db }
 * @returns {Promise<object|null>} snapshot.link_audit
 */
async function buildLinkStrategy({ project, commercial, topPages, db } = {}) {
  const cfg = getProjectsConfig().linkStrategy;
  if (!cfg || !cfg.enabled) return null;
  try {
    const links = project && project.id ? await loadLinks(project.id, db) : { anchors: [], pages: [], sites: [] };
    const audit = auditLinks({ project, links, topPages }) || { available: false };
    const recommend = recommendLinks({ project, commercial, linkAudit: audit, topPages });
    return {
      available: true,
      data_source: audit.data_source,
      has_link_data: !!audit.has_link_data,
      audit,
      recommendations: recommend.recommendations,
      recommendations_count: recommend.count,
    };
  } catch (err) {
    return { available: false, error: String(err && err.message || err) };
  }
}

module.exports = { buildLinkStrategy };
