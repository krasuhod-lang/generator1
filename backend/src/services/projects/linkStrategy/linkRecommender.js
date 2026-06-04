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
 * Тема статьи донора под целевой URL/запрос: «Как выбрать …», «Гид по …».
 */
function _donorTopic(query, targetUrl) {
  const base = query || _hostPath(targetUrl).replace(/[-_/]+/g, ' ');
  return `Экспертная статья по теме «${base}» с естественной ссылкой на ваш раздел`;
}

function _anchorVariants(query) {
  const q = String(query || '').trim();
  if (!q) return ['безанкорный (URL)'];
  return [q, `${q} — подробнее`, 'безанкорный (URL)'];
}

/**
 * @param {object} args { project, commercial, linkAudit, topPages }
 * @returns {{available:true, data_source, recommendations:Array, count}}
 */
function recommendLinks({ project, commercial, linkAudit, topPages } = {}) {
  const cfg = getProjectsConfig().linkStrategy;
  const min = cfg.minRecommendations || 5;
  const site = (project && (project.gsc_site_url || project.url)) || '';
  const recs = [];
  const seen = new Set();

  const push = (rec) => {
    const key = `${rec.target_url}::${rec.anchor}`;
    if (seen.has(key) || !rec.target_url) return;
    seen.add(key);
    recs.push(rec);
  };

  // 1) Орфаны с высокими показами — приоритетные цели линкбилдинга.
  const orphans = (linkAudit && linkAudit.orphans) || [];
  orphans.forEach((o) => {
    push({
      anchor: _anchorVariants(_hostPath(o.url).split('/').pop())[0],
      anchor_type: 'commercial',
      donor_topic: _donorTopic(null, o.url),
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
      push({
        anchor: _anchorVariants(_hostPath(p.key).split('/').pop().replace(/[-_]/g, ' '))[0],
        anchor_type: 'generic',
        donor_topic: _donorTopic(null, p.key),
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

module.exports = { recommendLinks };
