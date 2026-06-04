'use strict';

/**
 * linkStrategy/anchorAnalyzer — детерминированный анализ ссылочного профиля по
 * импортированным из GSC данным (п.1, п.2 ТЗ): анкор-облако, доля коммерческих/
 * брендовых/безанкорных анкоров, перекос по донорам, «голые» страницы без
 * входящих ссылок (gap по топ-страницам GSC).
 */

const { getProjectsConfig } = require('../config');
const { classifyQuery } = require('../commercialIntent');

function _norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/ё/g, 'е').trim(); }

const URL_LIKE = /^(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i;

/**
 * Классифицирует анкор: branded / commercial / naked(url) / generic.
 * @param {string} anchor
 * @param {string[]} brandTokens
 */
function classifyAnchor(anchor, brandTokens = []) {
  const a = _norm(anchor);
  if (!a) return 'empty';
  if (URL_LIKE.test(a) || /\b(тут|здесь|сайт|перейти|click here|here|read more|подробнее)\b/.test(a)) {
    return URL_LIKE.test(a) ? 'naked' : 'generic';
  }
  if (brandTokens.some((t) => t && a.includes(_norm(t)))) return 'branded';
  const intent = classifyQuery(a, { brandTokens }).intent;
  if (intent === 'transactional' || intent === 'commercial') return 'commercial';
  return 'generic';
}

/**
 * Анализ анкор-облака.
 * @param {Array} anchors [{anchor, links}]
 * @param {string[]} brandTokens
 */
function analyzeAnchors(anchors, brandTokens = []) {
  const cfg = getProjectsConfig().linkStrategy;
  const list = Array.isArray(anchors) ? anchors : [];
  const totals = { branded: 0, commercial: 0, naked: 0, generic: 0, empty: 0 };
  let totalLinks = 0;
  const cloud = list.map((a) => {
    const type = classifyAnchor(a.anchor, brandTokens);
    const links = Number(a.links) || 0;
    totals[type] = (totals[type] || 0) + links;
    totalLinks += links;
    return { anchor: a.anchor, links, type };
  });
  cloud.sort((x, y) => y.links - x.links);

  const pct = (n) => (totalLinks ? Math.round((n / totalLinks) * 1000) / 10 : 0);
  const distribution = {
    branded_pct: pct(totals.branded),
    commercial_pct: pct(totals.commercial),
    naked_pct: pct(totals.naked),
    generic_pct: pct(totals.generic),
  };

  // Перекос: один анкор забирает > anchorSkewThreshold всех ссылок (спам-сигнал).
  const topAnchor = cloud[0];
  const skew = topAnchor && totalLinks
    ? Math.round((topAnchor.links / totalLinks) * 100) / 100 : 0;
  const warnings = [];
  if (skew > cfg.anchorSkewThreshold) {
    warnings.push(`Переоптимизация: анкор «${topAnchor.anchor}» = ${Math.round(skew * 100)}% профиля.`);
  }
  if (distribution.naked_pct + distribution.generic_pct > cfg.nakedAnchorWarnPct * 100) {
    warnings.push('Слишком много безанкорных/общих анкоров — мало тематического веса.');
  }
  if (distribution.commercial_pct > 60) {
    warnings.push('Слишком высокая доля коммерческих анкоров — риск Penguin. Разбавьте брендовыми/безанкорными.');
  }

  return {
    available: list.length > 0,
    total_links: totalLinks,
    anchor_cloud: cloud.slice(0, 50),
    distribution,
    top_anchor_skew: skew,
    warnings,
  };
}

/**
 * Находит «голые» топ-страницы GSC, на которые нет входящих ссылок (gap).
 * @param {Array} topPages [{key:url, clicks, impressions}]
 * @param {Array} linkedPages [{target_page, links}]
 * @returns {{linked:Set, orphans:Array}}
 */
function findOrphanPages(topPages, linkedPages) {
  const linkedSet = new Set();
  (linkedPages || []).forEach((p) => {
    const u = _canonPath(p.target_page);
    if (u) linkedSet.add(u);
  });
  const orphans = (topPages || [])
    .filter((p) => p.key && !linkedSet.has(_canonPath(p.key)))
    .map((p) => ({ url: p.key, clicks: p.clicks || 0, impressions: p.impressions || 0 }));
  return { linkedSet, orphans };
}

function _canonPath(u) {
  if (!u) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return (url.hostname.replace(/^www\./, '') + url.pathname.replace(/\/$/, '')).toLowerCase();
  } catch (_) {
    return String(u).toLowerCase().replace(/\/$/, '');
  }
}

module.exports = { classifyAnchor, analyzeAnchors, findOrphanPages, _canonPath };
