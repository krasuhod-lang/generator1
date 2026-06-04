'use strict';

/**
 * linkStrategy/linkRecommender — генерирует рекомендации на покупку ссылок
 * (п.1 ТЗ: «анкор + тема статьи которую нужно раскрыть и куда статья на наш
 * сайт должна вести … От 5 рекомендаций всегда должно выдавать»).
 *
 * Детерминированный, ВСЕГДА возвращает ≥ cfg.minRecommendations: если «дыр»
 * из ссылочного аудита меньше — добивает за счёт коммерческих страниц в
 * striking distance и топ-страниц без бэклинков. Каждая рекомендация = анкор +
 * тип анкора + тема статьи-донора + целевой URL + обоснование + приоритет.
 */

const { getProjectsConfig } = require('../config');

function _hostPath(u) {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.pathname.replace(/^\/|\/$/g, '') || url.hostname;
  } catch (_) { return String(u || ''); }
}

/**
 * Обязательная формат-обёртка темы статьи-донора (внешний контракт — то, что
 * менеджер отдаёт донору). Выносим в одну функцию, чтобы и детерминированный
 * фолбэк, и обогащённый LLM-путь («Темы статей») использовали единый формат.
 */
function wrapDonorTopic(topicText) {
  const base = String(topicText == null ? '' : topicText).trim();
  return `Экспертная статья по теме «${base}» с естественной ссылкой на ваш раздел`;
}

/**
 * Тема статьи донора под целевой URL/запрос: «Как выбрать …», «Гид по …».
 */
function _donorTopic(query, targetUrl) {
  const base = query || _hostPath(targetUrl).replace(/[-_/]+/g, ' ');
  return wrapDonorTopic(base);
}

function _anchorVariants(query) {
  const q = String(query || '').trim();
  if (!q) return ['безанкорный (URL)'];
  return [q, `${q} — подробнее`, 'безанкорный (URL)'];
}

/**
 * Строит карту URL → лучший (по показам) поисковый запрос из матрицы GSC
 * query×page. Используется, чтобы анкор был реальным поисковым запросом,
 * который вбивают в поиск, а не окончанием URL (п.1 ТЗ).
 *
 * @param {Array} queryPage [{query, page, impressions}]
 * @returns {Map<string,string>} page → top query
 */
function _buildTopQueryByPage(queryPage) {
  const map = new Map();
  if (!Array.isArray(queryPage)) return map;
  const best = new Map(); // page → impressions лучшего запроса
  queryPage.forEach((r) => {
    const page = r && r.page;
    const query = r && String(r.query || '').trim();
    if (!page || !query) return;
    const impr = Number(r.impressions) || 0;
    if (!best.has(page) || impr > best.get(page)) {
      best.set(page, impr);
      map.set(page, query);
    }
  });
  return map;
}

/**
 * Анкор для целевого URL: приоритет — реальный поисковый запрос страницы из
 * GSC (то, что вбивают в поиск). Только если запросов нет — деградируем до
 * человекочитаемого слага URL.
 */
function _anchorForUrl(url, topQueryByPage, fallbackQuery) {
  const fromGsc = topQueryByPage && topQueryByPage.get(url);
  if (fromGsc) return fromGsc;
  if (fallbackQuery && String(fallbackQuery).trim()) return String(fallbackQuery).trim();
  const slug = _hostPath(url).split('/').pop().replace(/[-_]+/g, ' ').trim();
  return _anchorVariants(slug)[0];
}

/**
 * @param {object} args { project, commercial, linkAudit, topPages, queryPage }
 * @returns {{available:true, data_source, recommendations:Array, count}}
 */
function recommendLinks({ project, commercial, linkAudit, topPages, queryPage } = {}) {
  const cfg = getProjectsConfig().linkStrategy;
  const min = cfg.minRecommendations || 5;
  const site = (project && (project.gsc_site_url || project.url)) || '';
  const recs = [];
  const seen = new Set();
  const topQueryByPage = _buildTopQueryByPage(queryPage);

  const push = (rec) => {
    const key = `${rec.target_url}::${rec.anchor}`;
    if (seen.has(key) || !rec.target_url) return;
    seen.add(key);
    recs.push(rec);
  };

  // 1) Орфаны с высокими показами — приоритетные цели линкбилдинга.
  const orphans = (linkAudit && linkAudit.orphans) || [];
  orphans.forEach((o) => {
    const anchor = _anchorForUrl(o.url, topQueryByPage);
    const seed = topQueryByPage.get(o.url) || null;
    push({
      anchor,
      anchor_type: 'commercial',
      donor_topic_seed: seed || anchor,
      donor_topic: _donorTopic(seed, o.url),
      target_url: o.url,
      why: `Топ-страница (${o.impressions} показов) без входящих ссылок — наращиваем вес.`,
      priority: 'high',
    });
  });

  // 2) Коммерческие запросы в striking distance — усиливаем посадочные.
  const striking = (commercial && commercial.striking_distance) || [];
  striking.forEach((s) => {
    const target = s.landing_page || s.page || '';
    push({
      anchor: _anchorVariants(s.query)[0],
      anchor_type: 'commercial',
      donor_topic_seed: s.query,
      donor_topic: _donorTopic(s.query, target || site),
      target_url: target || site,
      why: `Коммерческий запрос «${s.query}» на позиции ${s.position} — ссылки добьют в топ.`,
      priority: 'high',
    });
  });

  // 3) Каннибализация/перекос анкоров — рекомендуем разбавляющие анкоры.
  const distribution = linkAudit && linkAudit.anchors && linkAudit.anchors.distribution;
  if (distribution && distribution.commercial_pct > 50) {
    push({
      anchor: project && project.name ? project.name : 'безанкорный (URL)',
      anchor_type: 'branded',
      donor_topic: 'Обзор/упоминание бренда на тематическом ресурсе',
      target_url: site,
      why: 'Анкор-профиль перекошен в коммерцию — разбавляем брендовыми анкорами.',
      priority: 'medium',
    });
  }

  // 4) Добиваем до минимума топ-страницами (любой data_source).
  if (recs.length < min) {
    const pages = (topPages || []).slice().sort((a, b) => (b.impressions || 0) - (a.impressions || 0));
    for (const p of pages) {
      if (recs.length >= min) break;
      const seed = topQueryByPage.get(p.key) || null;
      push({
        anchor: _anchorForUrl(p.key, topQueryByPage),
        anchor_type: 'generic',
        donor_topic_seed: seed || _anchorForUrl(p.key, topQueryByPage),
        donor_topic: _donorTopic(seed, p.key),
        target_url: p.key,
        why: `Расширение ссылочной массы на значимую страницу (${p.impressions || 0} показов).`,
        priority: 'medium',
      });
    }
  }

  // 5) Финальный страховочный добор (если совсем мало данных) — на главную.
  while (recs.length < min && site) {
    const i = recs.length + 1;
    push({
      anchor: i % 2 === 0 ? (project && project.name) || 'бренд' : 'безанкорный (URL)',
      anchor_type: i % 2 === 0 ? 'branded' : 'naked',
      donor_topic: 'Тематическая статья с упоминанием и ссылкой на сайт',
      target_url: `${site}#rec${i}`,
      why: 'Базовое расширение ссылочного профиля (мало данных GSC по ссылкам).',
      priority: 'low',
    });
  }

  return {
    available: true,
    data_source: (linkAudit && linkAudit.data_source) || 'inferred',
    recommendations: recs.slice(0, Math.max(min, recs.length)),
    count: recs.length,
  };
}

module.exports = { recommendLinks, wrapDonorTopic };
