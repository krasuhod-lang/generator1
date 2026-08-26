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

function _uniqueStrings(values) {
  const seen = new Set();
  return values
    .map((value) => String(value == null ? '' : value).trim())
    .filter((value) => value && !seen.has(value.toLowerCase()) && seen.add(value.toLowerCase()));
}

/**
 * Формирует варианты анкоров из реального GSC query, бренда и URL-контекста.
 * Exact-match остаётся в списке, но при перекосе профиля получает risk-флаг и
 * заменяется на более естественный recommended_anchor. Фиксированных «идеальных»
 * процентов не объявляем: это decision-support, а не обещание алгоритму.
 */
function _buildAnchorPlan(rec, project, linkAudit) {
  const seed = String(rec && (rec.donor_topic_seed || rec.anchor) || '').trim();
  const site = String((project && (project.gsc_site_url || project.url)) || '').trim();
  const brand = String((project && project.name) || '').trim();
  const target = String((rec && rec.target_url) || '').trim();
  const slug = _hostPath(target).split('/').pop().replace(/[-_]+/g, ' ').trim();
  const distribution = linkAudit && linkAudit.anchors && linkAudit.anchors.distribution;
  const commercialPct = Number(distribution && distribution.commercial_pct) || 0;
  const skew = Number(linkAudit && linkAudit.anchors && linkAudit.anchors.top_anchor_skew) || 0;
  const diversified = commercialPct >= 45 || skew > 0.6;
  const isHome = Boolean(site && target && _hostPath(target) === _hostPath(site));
  const variants = _uniqueStrings([
    seed,
    seed ? `${seed} — подробнее` : '',
    seed ? `как выбрать: ${seed}` : '',
    slug,
    brand && isHome ? brand : '',
    brand && isHome ? `${brand} — официальный сайт` : '',
    'подробнее',
    target,
  ]).slice(0, 7);
  const recommended = diversified
    ? (isHome && brand ? brand : variants.find((value) => value.toLowerCase() !== seed.toLowerCase() && value !== target) || seed)
    : (seed || variants[0] || target);
  return {
    recommended_anchor: recommended,
    recommended_anchor_type: recommended === brand ? 'branded' : (recommended === target ? 'naked' : 'contextual'),
    variants,
    profile: { commercial_pct: commercialPct, top_anchor_skew: skew },
    risk: diversified ? 'diversify' : 'normal',
    guidance: diversified
      ? 'Профиль уже содержит повышенную долю коммерческих/повторяющихся анкоров: чередуйте брендовые, contextual и URL-варианты; exact-match не ставьте подряд.'
      : 'Используйте описательный анкор только там, где он естественно читается в предложении; чередуйте его с брендовым и contextual-вариантами.',
  };
}

function _competitionContext(rec) {
  const position = Number(rec && rec.position);
  const impressions = Number(rec && rec.impressions) || 0;
  if (Number.isFinite(position) && position > 0 && position <= 20) {
    return {
      signal: 'striking_distance',
      position,
      impressions,
      rationale: 'Страница уже видна в Google Search Console и находится в зоне роста; ссылка имеет измеримую цель.',
    };
  }
  if (rec && rec.priority === 'high') {
    return {
      signal: 'high_priority_gap',
      position: null,
      impressions,
      rationale: 'Цель выбрана по коммерческому интенту или ссылочному gap; позиция не была передана в этот recommendation row.',
    };
  }
  return {
    signal: 'supporting_target',
    position: Number.isFinite(position) ? position : null,
    impressions,
    rationale: 'Вспомогательная цель из текущего GSC/content-среза, без доказанного конкурентного backlink gap.',
  };
}

function _articleBrief(rec) {
  const intent = String((rec && rec.intent) || '').toLowerCase();
  const commercial = Boolean(rec && rec.commercial);
  if (intent === 'transactional' || commercial) {
    return {
      format: 'практический гид или сравнение',
      angle: 'Критерии выбора, сценарии применения, ограничения и проверяемые основания для решения.',
      evidence: 'Сравнительная таблица, чек-лист выбора, источники и честное обозначение ограничений.',
      link_rule: 'Ссылка должна быть частью полезного объяснения, а не единственной целью статьи.',
    };
  }
  if (intent === 'investigation') {
    return {
      format: 'экспертный разбор или обзор',
      angle: 'Разбор вариантов, рисков и критериев оценки перед принятием решения.',
      evidence: 'Методика сравнения, практический пример, источники и критерии проверки результата.',
      link_rule: 'Анкор вписывается в контекст вывода или следующего шага читателя.',
    };
  }
  return {
    format: 'how-to, чек-лист или объясняющая статья',
    angle: 'Пошаговое решение задачи читателя с примерами, ошибками и понятным следующим действием.',
    evidence: 'Пошаговая схема, факты/источники, FAQ и условия применимости рекомендаций.',
    link_rule: 'Ссылка ставится только в предложении, где она помогает закрыть конкретный информационный gap.',
  };
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
      position: Number(s.position) || null,
      impressions: Number(s.impressions) || 0,
      intent: s.intent || 'commercial',
      donor_topic_seed: s.query,
      donor_topic: _donorTopic(s.query, target || site),
      target_url: target || site,
      why: `Коммерческий запрос «${s.query}» на позиции ${s.position} — релевантные ссылки могут приблизить посадочную к топу.`,
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
      impressions: Number(o.impressions) || 0,
      why: isCommercial
        ? `Коммерческая страница (${o.impressions} показов) без входящих ссылок — проверяем релевантное усиление.`
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
        impressions: Number(p.impressions) || 0,
        position: Number(p.position) || null,
        why: isCommercial
          ? `Усиление коммерческой страницы (${p.impressions || 0} показов).`
          : `Расширение ссылочной массы на значимую страницу (${p.impressions || 0} показов).`,
        priority: isCommercial ? 'high' : 'medium',
      });
    }
  }

  // 5) Финальный страховочный добор (если совсем мало данных) — на реальный
  // canonical URL. Никаких искусственных #rec-путей: они не являются отдельными
  // посадочными страницами. Конечный список защищает от бесконечного fallback-loop.
  const fallbackAnchors = _uniqueStrings([
    project && project.name,
    'официальный сайт',
    'подробнее на сайте',
    'на сайте компании',
    'сайт компании',
    'узнать подробнее',
    site,
  ]);
  let fallbackIndex = 0;
  while (recs.length < min && site && fallbackIndex < fallbackAnchors.length) {
    const anchor = fallbackAnchors[fallbackIndex];
    fallbackIndex += 1;
    const anchorType = anchor === site ? 'naked' : (anchor === (project && project.name) ? 'branded' : 'generic');
    push({
      anchor,
      anchor_type: anchorType,
      commercial: false,
      donor_topic: 'Тематическая статья с упоминанием и ссылкой на сайт',
      target_url: site,
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

  const recommendations = ordered.map((rec) => ({
    ...rec,
    anchor_plan: _buildAnchorPlan(rec, project, linkAudit),
    competition: _competitionContext(rec),
    article_brief: _articleBrief(rec),
  }));

  return {
    available: true,
    data_source: (linkAudit && linkAudit.data_source) || 'inferred',
    recommendations: recommendations.slice(0, Math.max(min, recommendations.length)),
    count: recommendations.length,
    commercial_count: recommendations.filter((r) => r.commercial).length,
    competitive_basis: {
      own_gsc_search_data: Array.isArray(queryPage) && queryPage.length > 0,
      own_gsc_link_export: Boolean(linkAudit && linkAudit.has_link_data),
      competitor_backlink_data: false,
      serp_competitor_data: false,
      missing_signals: ['конкурентные доноры', 'их анкоры', 'тематическая релевантность площадки', 'редакционный трафик'],
      note: 'Конкурентные backlink-метрики не выводятся из GSC: для них нужен отдельный конкурентный export/API. Текущие рекомендации честно опираются на собственные GSC-сигналы и маркируются как такие.',
    },
  };
}

module.exports = { recommendLinks, wrapDonorTopic };
