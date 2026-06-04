'use strict';

/**
 * geoAeo/aiVisibilityProbe — опциональный пробник присутствия в SERP-фичах,
 * влияющих на нейровыдачу (п.7 ТЗ). Search API не отдаёт факт показа в AI
 * Overviews/SGE напрямую, поэтому используем косвенные сигналы по реальному
 * топу Google (через существующий xmlstockClient): входит ли наш домен в топ-N
 * по приоритетному запросу (кандидат на цитирование ИИ).
 *
 * Сетевой и graceful: при отсутствии ключа/ошибке возвращает inferred-результат
 * без падения пайплайна.
 */

const { getProjectsConfig } = require('../config');

function _domainOf(u) {
  try { return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, ''); }
  catch (_) { return String(u || '').toLowerCase().replace(/^www\./, '').split('/')[0]; }
}

/**
 * @param {object} args { project, topQueries, fetchSerp? }
 *   fetchSerp — inject для тестов (по умолчанию xmlstockClient.fetchGoogleSerp).
 * @returns {Promise<{available, data_source, probes:Array}>}
 */
async function probeAiVisibility({ project, topQueries = [], fetchSerp = null } = {}) {
  const cfg = getProjectsConfig().geoAeo;
  if (!cfg || !cfg.enabled) return null;

  const siteDomain = _domainOf((project && (project.gsc_site_url || project.url)) || '');
  const queries = (topQueries || [])
    .filter((r) => (Number(r.impressions) || 0) >= (cfg.minImpressions || 30))
    .slice(0, cfg.maxProbeQueries || 10);

  if (!queries.length) return { available: true, data_source: 'inferred', probes: [] };

  let serpFn = fetchSerp;
  if (!serpFn) {
    try { serpFn = require('../../metaTags/xmlstockClient').fetchGoogleSerp; }
    catch (_) { serpFn = null; }
  }

  const probes = [];
  let dataSource = 'inferred';
  for (const r of queries) {
    const q = r.key || r.query;
    let includesUs = null;
    let topDomains = [];
    if (serpFn) {
      try {
        const docs = await serpFn(q, { pages: 1 });
        dataSource = 'serp';
        topDomains = (docs || []).slice(0, 10).map((d) => _domainOf(d.url));
        includesUs = siteDomain ? topDomains.includes(siteDomain) : null;
      } catch (_) { /* graceful per-query */ }
    }
    probes.push({
      query: q,
      impressions: Number(r.impressions) || 0,
      position: Number(r.position) || null,
      sge_includes_us: includesUs,
      top_domains: topDomains.slice(0, 5),
      // косвенный приоритет на попадание в нейровыдачу: высокий спрос + мы не в топе.
      ai_opportunity: includesUs === false || (includesUs === null && (Number(r.position) || 99) > 5),
    });
  }

  return { available: true, data_source: dataSource, probes };
}

module.exports = { probeAiVisibility, _domainOf };
