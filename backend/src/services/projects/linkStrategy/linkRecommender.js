'use strict';

/**
 * linkStrategy/linkRecommender — генерирует рекомендации на покупку ссылок
 * (п.1 ТЗ: «анкор + тема статьи которую нужно раскрыть и куда статья на наш
 * сайт должна вести … От 5 рекомендаций всегда должно выдавать»).
 *
 * ПРИОРИТЕТ №1 — КОММЕРЧЕСКИЕ ЗАПРОСЫ. Ссылочная масса покупается ради денег:
 * сначала усиливаем посадочные под коммерческие запросы у входа в топ
 * (transactional → commercial → investigation), затем коммерческие страницы без
 * бэклинков, и только потом информационные страницы и общий добор.
 *
 * Детерминированный, ВСЕГДА возвращает ≥ cfg.minRecommendations: если «дыр»
 * из ссылочного аудита меньше — добивает за счёт коммерческих страниц в
 * striking distance и топ-страниц без бэклинков. Каждая рекомендация = анкор +
 * тип анкора + тема статьи-донора + целевой URL + обоснование + приоритет.
 */

const { getProjectsConfig } = require('../config');
const { classifyLanding, classifyQuery } = require('../commercialIntent');

// Вес коммерческого интента запроса: чем ближе к деньгам, тем выше в списке.
const INTENT_WEIGHT = Object.freeze({
  transactional: 3,
  commercial: 2,
  investigation: 1,
});

// Вес приоритета — для финальной сортировки внутри одной группы.
const PRIORITY_WEIGHT = Object.freeze({ high: 3, medium: 2, low: 1 });

function _hostPath(u) {
  try {
    const url = new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`);
    return url.pathname.replace(/^\/|\/$/g, '') || url.hostname;
  } catch (_) { return String(u || ''); }
}

/**
 * Тема статьи-донора — это РАБОЧИЙ ЗАГОЛОВОК готовой статьи под анкор (то, что
 * менеджер отдаёт донору). По требованию заказчика выводим саму тему статьи
 * НАПРЯМУЮ, без обёртки «Экспертная статья по теме «…» с естественной ссылкой
 * на ваш раздел» — менеджеру нужна сразу конкретная тема, а не служебная фраза.
 * Оставляем единую точку нормализации, чтобы и детерминированный фолбэк, и
 * обогащённый LLM-путь («Темы статей») давали одинаковый формат.
 */
function wrapDonorTopic(topicText) {
  return String(topicText == null ? '' : topicText).trim();
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
 * Карта «нормализованный запрос → лучшая по показам посадочная страница».
 * Нужна, чтобы коммерческий запрос вёл на СВОЮ посадочную, а не на главную:
 * commercial.striking_distance исторически мог приходить без landing_page.
 */
function _buildPageByQuery(queryPage) {
  const map = new Map();
  if (!Array.isArray(queryPage)) return map;
  const best = new Map();
  queryPage.forEach((r) => {
    const q = String((r && r.query) || '').toLowerCase().trim();
    const page = r && r.page;
    if (!q || !page) return;
    const impr = Number(r.impressions) || 0;
    if (!best.has(q) || impr > best.get(q)) {
      best.set(q, impr);
      map.set(q, page);
    }
  });
  return map;
}

/**
 * Коммерческая ли цель ссылки: сначала смотрим на тип посадочной (каталог /
 * товар / услуги / цены), затем — на интент запроса-анкора. Информационные
 * (блог, статьи) страницы коммерческими не считаем.
 */
function _isCommercialTarget(url, query) {
  const landing = classifyLanding(url);
  if (landing === 'commerce') return true;
  if (landing === 'info') return false;
  try {
    const c = classifyQuery(query);
    return Boolean(c && c.commercial);
  } catch (_) { return false; }
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
  const pageByQuery = _buildPageByQuery(queryPage);

  const push = (rec) => {
    const key = `${rec.target_url}::${rec.anchor}`;
    if (seen.has(key) || !rec.target_url) return;
    seen.add(key);
    recs.push(rec);
  };

  // 1) ПРИОРИТЕТ №1 — коммерческие запросы в striking distance: усиливаем
  // посадочные, которые уже почти в топе и приносят деньги. Внутри группы
  // сортируем по интенту (transactional → commercial → investigation), а при
  // равном интенте — по показам.
  const striking = ((commercial && commercial.striking_distance) || [])
    .slice()
    .sort((a, b) => {
      const wa = INTENT_WEIGHT[a && a.intent] || 0;
      const wb = INTENT_WEIGHT[b && b.intent] || 0;
      if (wa !== wb) return wb - wa;
      return (Number(b && b.impressions) || 0) - (Number(a && a.impressions) || 0);
    });
  striking.forEach((s) => {
    // landing_page может отсутствовать в срезе — восстанавливаем по query×page,
    // иначе рекомендация уходила на главную и не усиливала нужную посадочную.
    const target = s.landing_page || s.page
      || pageByQuery.get(String(s.query || '').toLowerCase().trim())
      || site;
    push({
      anchor: _anchorVariants(s.query)[0],
      anchor_type: 'commercial',
      commercial: true,
      intent: s.intent || 'commercial',
      donor_topic_seed: s.query,
      donor_topic: _donorTopic(s.query, target || site),
      target_url: target || site,
      why: `Коммерческий запрос «${s.query}» на позиции ${s.position} — ссылки добьют в топ.`,
      priority: 'high',
    });
  });

  // 2) Орфаны без входящих ссылок. Коммерческие страницы — высокий приоритет,
  // информационные (блог/статьи) — ниже: ссылочный бюджет идёт в коммерцию.
  const orphans = (linkAudit && linkAudit.orphans) || [];
  orphans.forEach((o) => {
    const anchor = _anchorForUrl(o.url, topQueryByPage);
    const seed = topQueryByPage.get(o.url) || null;
    const isCommercial = _isCommercialTarget(o.url, seed || anchor);
    push({
      anchor,
      anchor_type: isCommercial ? 'commercial' : 'generic',
      commercial: isCommercial,
      donor_topic_seed: seed || anchor,
      donor_topic: _donorTopic(seed, o.url),
      target_url: o.url,
      why: isCommercial
        ? `Коммерческая страница (${o.impressions} показов) без входящих ссылок — наращиваем вес.`
        : `Информационная страница (${o.impressions} показов) без входящих ссылок — усиливаем после коммерческих.`,
      priority: isCommercial ? 'high' : 'medium',
    });
  });

  // 3) Каннибализация/перекос анкоров — рекомендуем разбавляющие анкоры.
  const distribution = linkAudit && linkAudit.anchors && linkAudit.anchors.distribution;
  if (distribution && distribution.commercial_pct > 50) {
    push({
      anchor: project && project.name ? project.name : 'безанкорный (URL)',
      anchor_type: 'branded',
      commercial: false,
      donor_topic: 'Обзор/упоминание бренда на тематическом ресурсе',
      target_url: site,
      why: 'Анкор-профиль перекошен в коммерцию — разбавляем брендовыми анкорами.',
      priority: 'medium',
    });
  }

  // 4) Добиваем до минимума топ-страницами (любой data_source). Коммерческие
  // страницы берём первыми — они ближе к деньгам, чем инфо-трафик.
  if (recs.length < min) {
    const pages = (topPages || []).slice().sort((a, b) => {
      const ca = _isCommercialTarget(a && a.key, topQueryByPage.get(a && a.key)) ? 1 : 0;
      const cb = _isCommercialTarget(b && b.key, topQueryByPage.get(b && b.key)) ? 1 : 0;
      if (ca !== cb) return cb - ca;
      return (b.impressions || 0) - (a.impressions || 0);
    });
    for (const p of pages) {
      if (recs.length >= min) break;
      const seed = topQueryByPage.get(p.key) || null;
      const anchor = _anchorForUrl(p.key, topQueryByPage);
      const isCommercial = _isCommercialTarget(p.key, seed || anchor);
      push({
        anchor,
        anchor_type: isCommercial ? 'commercial' : 'generic',
        commercial: isCommercial,
        donor_topic_seed: seed || anchor,
        donor_topic: _donorTopic(seed, p.key),
        target_url: p.key,
        why: isCommercial
          ? `Усиление коммерческой страницы (${p.impressions || 0} показов).`
          : `Расширение ссылочной массы на значимую страницу (${p.impressions || 0} показов).`,
        priority: isCommercial ? 'high' : 'medium',
      });
    }
  }

  // 5) Финальный страховочный добор (если совсем мало данных) — на главную.
  while (recs.length < min && site) {
    const i = recs.length + 1;
    push({
      anchor: i % 2 === 0 ? (project && project.name) || 'бренд' : 'безанкорный (URL)',
      anchor_type: i % 2 === 0 ? 'branded' : 'naked',
      commercial: false,
      donor_topic: 'Тематическая статья с упоминанием и ссылкой на сайт',
      target_url: `${site}#rec${i}`,
      why: 'Базовое расширение ссылочного профиля (мало данных GSC по ссылкам).',
      priority: 'low',
    });
  }

  // Финальный порядок: коммерческие цели выше информационных, внутри — по
  // приоритету. Сортировка стабильная (Array.prototype.sort в Node), поэтому
  // порядок формирования групп сохраняется при равных весах.
  const ordered = recs.slice().sort((a, b) => {
    const ca = a.commercial ? 1 : 0;
    const cb = b.commercial ? 1 : 0;
    if (ca !== cb) return cb - ca;
    const pa = PRIORITY_WEIGHT[a.priority] || 0;
    const pb = PRIORITY_WEIGHT[b.priority] || 0;
    return pb - pa;
  });

  return {
    available: true,
    data_source: (linkAudit && linkAudit.data_source) || 'inferred',
    recommendations: ordered.slice(0, Math.max(min, ordered.length)),
    count: ordered.length,
    commercial_count: ordered.filter((r) => r.commercial).length,
  };
}

module.exports = { recommendLinks, wrapDonorTopic };
