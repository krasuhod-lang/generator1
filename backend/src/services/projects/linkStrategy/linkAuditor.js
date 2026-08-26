'use strict';

/**
 * linkStrategy/linkAuditor — диагностический аудит ссылочного профиля по данным
 * GSC (п.2 ТЗ: «Делать нужно оценку раздела ссылок из гугл серч консоли, какие
 * анкоры, доноры, что ссылается, и что нужно поправлять»).
 *
 * Сводит выводы anchorAnalyzer + donorScorer + orphan-страницы в единый
 * диагностический срез с конкретными «что поправлять». Детерминированный.
 */

const { getProjectsConfig } = require('../config');
const { analyzeAnchors, findOrphanPages } = require('./anchorAnalyzer');
const { scoreDonors } = require('./donorScorer');
const { deriveBrandTokens } = require('../commercialIntent');

/**
 * @param {object} args
 *   { project, links:{anchors:[], pages:[], sites:[]}, topPages:[] }
 *   links — нормализованные строки импортов (по типам таблиц GSC).
 * @returns {{available, data_source, anchors, donors, orphans, issues}}
 */
function auditLinks({ project, links, topPages } = {}) {
  const cfg = getProjectsConfig().linkStrategy;
  if (!cfg || !cfg.enabled) return null;

  const anchors = (links && links.anchors) || [];
  const pages = (links && links.pages) || [];
  const sites = (links && links.sites) || [];
  const hasData = anchors.length + pages.length + sites.length > 0;

  const brandTokens = deriveBrandTokens({
    name: project && project.name,
    siteUrl: project && project.gsc_site_url,
    url: project && project.url,
  });

  const anchorReport = analyzeAnchors(anchors, brandTokens);
  const donorReport = scoreDonors(sites).slice(0, cfg.topDonors);
  const { linkedSet, orphans } = findOrphanPages(topPages || [], pages);
  const targetPageRows = pages
    .filter((p) => p && p.target_page)
    .map((p) => ({
      target_page: p.target_page,
      links: Number(p.links) || 0,
      referring_sites: Number(p.referring_sites) || 0,
    }))
    .sort((a, b) => (b.links - a.links) || (b.referring_sites - a.referring_sites));
  const targetPageTotals = targetPageRows.reduce((acc, row) => ({
    target_pages: acc.target_pages + 1,
    incoming_links: acc.incoming_links + row.links,
    referring_sites: acc.referring_sites + row.referring_sites,
  }), { target_pages: 0, incoming_links: 0, referring_sites: 0 });

  const issues = [];
  anchorReport.warnings.forEach((w) => issues.push({ kind: 'anchor', message: w }));

  // Доноры с риском.
  const riskyDonors = donorReport.filter((d) => d.trust_score < 40 || d.flags.includes('risky_host'));
  if (riskyDonors.length) {
    issues.push({
      kind: 'donor',
      message: `${riskyDonors.length} доноров с низким доверием — проверьте и при необходимости отклоните (Disavow).`,
      donors: riskyDonors.slice(0, 10).map((d) => d.host),
    });
  }

  // Орфаны: важные страницы без ссылок.
  const importantOrphans = orphans
    .sort((a, b) => (b.impressions || 0) - (a.impressions || 0))
    .slice(0, cfg.topTargetPages);
  if (importantOrphans.length) {
    issues.push({
      kind: 'orphan',
      message: `${importantOrphans.length} топ-страниц без входящих ссылок — приоритетные цели для линкбилдинга.`,
    });
  }

  return {
    available: true,
    // Сохраняем историческое API-значение gsc_csv для совместимости; оно
    // означает ручную выгрузку GSC в CSV или XLSX.
    data_source: hasData ? 'gsc_csv' : 'inferred',
    has_link_data: hasData,
    anchors: anchorReport,
    donors: donorReport,
    target_pages: targetPageRows.slice(0, cfg.topTargetPages),
    target_page_totals: targetPageTotals,
    orphans: importantOrphans,
    linked_count: linkedSet.size,
    issues,
    // множество URL с бэклинками — используется eatScorer (Authoritativeness).
    _linked_urls: Array.from(linkedSet),
  };
}

module.exports = { auditLinks };
