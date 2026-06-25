'use strict';

/**
 * reports/modules/index.js — оркестратор модулей отчёта (ТЗ §1.4 MVP-скоуп):
 * Executive Summary, Striking Distance, CTR Gap, Content Health, Off-Page
 * Monitor, Tech Audit.
 *
 * assembleModules() собирает все включённые модули из уже подготовленных
 * данных (срез GSC query×page, опционально Yandex, частотности Keys.so,
 * результаты tech-audit, бэклинки). Чистая функция: без БД/сети.
 */

const { buildStrikingDistance } = require('./strikingDistance');
const { buildCtrGaps } = require('./ctrGap');
const { buildContentHealth } = require('./contentHealth');
const { summarizeTechAudit } = require('./techAudit');
const { summarizeBacklinks } = require('./offPage');
const { normalizeSettings, DEFAULT_SETTINGS } = require('./settings');

const ALL_MODULES = ['executive', 'striking_distance', 'ctr_gap', 'content_health', 'off_page', 'tech_audit'];

// ТЗ-правка: CTR Gap и Content Health убираем, Off-Page Monitor и Tech Audit
// скрываем (непонятно/не работает). Эти модули отключены по умолчанию и
// включаются только явным config.<module> = true.
const DEFAULT_DISABLED = new Set(['ctr_gap', 'content_health', 'off_page', 'tech_audit']);

function _enabled(config, name) {
  // Явное значение в config имеет приоритет (true/false).
  if (config && config[name] != null) return config[name] !== false;
  // Иначе — дефолт: большинство модулей включено, отключённые по умолчанию скрыты.
  return !DEFAULT_DISABLED.has(name);
}

function _ctrGapUrlSet(ctrGap) {
  const set = new Set();
  for (const it of ctrGap.items || []) if (it.url) set.add(it.url);
  return set;
}

/**
 * @param {object} input
 *   - queryPageRows: Array  GSC срез query×page {query,url,clicks,impressions,position}
 *   - ydxRows:       Array  Yandex срез (опц.) — для CTR Gap по Яндексу
 *   - volumeByQuery: object query → частотность
 *   - techAudit:     Array  результаты techAudit.auditUrl/auditHtml
 *   - backlinks:     Array  бэклинки со статусом
 *   - positionDeltaByUrl: object url → дельта позиции за 30д
 *   - impressionsTrendByUrl: object url → 'declining_2m' | ...
 * @param {object} opts {settings, config}
 */
function assembleModules(input = {}, opts = {}) {
  const settings = normalizeSettings(opts.settings);
  const config = opts.config || {};
  const enabledModules = ALL_MODULES.filter((m) => _enabled(config, m));

  const queryPageRows = input.queryPageRows || [];
  const volumeByQuery = input.volumeByQuery || {};
  const techAuditResults = input.techAudit || [];
  const backlinks = input.backlinks || [];

  const out = { enabled: enabledModules, settings, generated_at: new Date().toISOString() };

  const striking = buildStrikingDistance(queryPageRows, { settings, volumeByQuery });
  if (_enabled(config, 'striking_distance')) out.striking_distance = striking;

  const ctrGap = buildCtrGaps(queryPageRows, { settings, engine: 'google' });
  if (_enabled(config, 'ctr_gap')) out.ctr_gap = ctrGap;

  const tech = summarizeTechAudit(techAuditResults);
  if (_enabled(config, 'tech_audit')) out.tech_audit = tech;

  let content = { items: [], summary: { total: 0, healthy: 0, needs_work: 0, critical: 0, avg_score: 100 } };
  if (_enabled(config, 'content_health')) {
    const ctrGapUrls = _ctrGapUrlSet(ctrGap);
    const techByUrl = new Map();
    for (const t of tech.items) if (t.url) techByUrl.set(t.url, t);
    const positionDeltaByUrl = input.positionDeltaByUrl || {};
    const impressionsTrendByUrl = input.impressionsTrendByUrl || {};

    const urls = new Set([...techByUrl.keys(), ...ctrGapUrls, ...Object.keys(positionDeltaByUrl)]);
    const urlData = [...urls].map((url) => {
      const t = techByUrl.get(url) || {};
      return {
        url,
        is_ctr_gap: ctrGapUrls.has(url),
        position_delta_30d: positionDeltaByUrl[url] != null ? Number(positionDeltaByUrl[url]) : null,
        impressions_trend: impressionsTrendByUrl[url] || null,
        images_no_alt_ratio: t.images_no_alt_ratio != null ? t.images_no_alt_ratio : null,
        webp_ratio: t.webp_ratio != null ? t.webp_ratio : null,
      };
    });
    content = buildContentHealth(urlData);
    out.content_health = content;
  }

  const offPage = summarizeBacklinks(backlinks);
  if (_enabled(config, 'off_page')) out.off_page = offPage;

  if (_enabled(config, 'executive')) {
    out.executive = {
      striking_distance: striking.summary,
      ctr_gap: ctrGap.summary,
      content_health: content.summary,
      off_page: offPage.summary,
      tech_audit: tech.summary,
    };
  }

  return out;
}

module.exports = {
  assembleModules,
  ALL_MODULES,
  DEFAULT_SETTINGS,
  // re-export для удобства потребителей и тестов
  buildStrikingDistance,
  buildCtrGaps,
  buildContentHealth,
  summarizeTechAudit,
  summarizeBacklinks,
  normalizeSettings,
};
