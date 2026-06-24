'use strict';

/**
 * projects/commercialIntent.js — детерминированный слой анализа GSC с акцентом
 * на коммерческий трафик. Без сети и LLM: классифицирует запросы по интенту,
 * считает долю коммерческого трафика и находит точки роста выручки.
 *
 * Результат отдаётся:
 *   • в gsc_snapshot (для UI-карточки «Коммерческий срез»);
 *   • в user-prompt DeepSeek (раздел «6. Коммерческий рост»).
 *
 * Всё graceful: на пустых/битых данных возвращает безопасный пустой срез,
 * никогда не бросает.
 */

const { getProjectsConfig } = require('./config');

// Интенты, считающиеся «коммерческими» (приносят/готовы приносить выручку).
const COMMERCIAL_INTENTS = ['transactional', 'commercial', 'investigation'];

function _norm(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[ё]/g, 'е').trim();
}

function _round(n, p = 2) {
  const f = Math.pow(10, p);
  return Math.round((Number(n) || 0) * f) / f;
}

/**
 * Извлекает «брендовые» токены из названия проекта и домена сайта, чтобы
 * отделять брендовый спрос от небрендового.
 * @returns {string[]} нормализованные токены длиной ≥ 3
 */
function deriveBrandTokens({ name, siteUrl, url } = {}) {
  const tokens = new Set();
  const add = (raw) => {
    _norm(raw)
      .split(/[^a-zа-я0-9]+/i)
      .filter((t) => t && t.length >= 3 && !/^\d+$/.test(t))
      .forEach((t) => tokens.add(t));
  };
  add(name);
  // Хост из site_url / url — без www, доменной зоны и распространённых слов.
  const host = _extractHost(siteUrl) || _extractHost(url);
  if (host) {
    host.split('.').slice(0, -1).forEach((part) => {
      if (part && part !== 'www') add(part);
    });
  }
  const STOP = new Set(['the', 'and', 'для', 'про', 'сайт', 'com', 'www', 'ооо', 'ип', 'pro']);
  return Array.from(tokens).filter((t) => !STOP.has(t));
}

function _extractHost(u) {
  if (!u) return '';
  try {
    const s = /^https?:\/\//i.test(u) ? u : `https://${u}`;
    return new URL(s).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

/**
 * Классифицирует поисковый запрос по интенту.
 *
 * Новый алгоритм (см. ТЗ §4): вместо «первый сработавший словарь побеждает»
 * считаем взвешенный score каждого интента и берём максимум. Это решает
 * проблему «обзор лучших CRM» / «что такое услуга факторинга» → раньше такие
 * запросы попадали в commercial по слабому слову («услуга», «обзор»), теперь
 * сильные информационные триггеры (вопросительные «что такое», «как», «почему»
 * и т.п.) перекрывают слабый коммерческий маркер.
 *
 * Веса (по умолчанию, переопределяются в config.commercial.intentScoring):
 *   • transactional strong (купить/заказать/цена/доставка) → +3 (бьёт всё)
 *   • commercial strong  (услуга/аренда/ремонт/тариф)      → +2
 *     • снижается до +1, если в запросе есть strong informational маркер
 *   • investigation      (отзывы/обзор/рейтинг/vs)         → +2
 *     • снижается до +1, если в запросе есть strong informational маркер
 *   • informational strong (что такое/как/почему/гайд/...) → +3
 *   • informational weak  (любой словарный матч)           → +1
 *   • navigational        (личный кабинет/вход/контакты)   → +2
 * Тай-брейк при равенстве: transactional > commercial > investigation
 *                          > informational > navigational > other.
 *
 * @param {string} query
 * @param {Object} opts { brandTokens, dictionaries, scoring }
 * @returns {{intent:string, branded:boolean, commercial:boolean,
 *            confidence:number, signals:{matched:string[], scores:Object}}}
 */
function classifyQuery(query, opts = {}) {
  const q = _norm(query);
  const cfg = getProjectsConfig().commercial;
  const dict = opts.dictionaries || cfg.dictionaries;
  const scoring = opts.scoring || cfg.intentScoring || _defaultScoring();
  const brandTokens = Array.isArray(opts.brandTokens) ? opts.brandTokens : [];

  const branded = brandTokens.length > 0
    && brandTokens.some((t) => t && _wordHit(q, t));

  // Шаг 1: какие словарные категории сработали и какие конкретные термы.
  const matched = { transactional: [], commercial: [], investigation: [], informational: [], navigational: [] };
  for (const cat of Object.keys(matched)) {
    const list = dict[cat];
    if (!Array.isArray(list)) continue;
    for (const term of list) {
      if (_termHit(q, term)) matched[cat].push(_norm(term));
    }
  }

  // Шаг 2: сильные информационные триггеры — подмножество informational,
  // которые задают «вопросительный» характер запроса. Список тоже
  // конфигурируем (cfg.intentScoring.strongInformational), плюс эвристика:
  // если запрос начинается с одного из 'как/что такое/почему/зачем/когда/где/
  // сколько' (первые 2 слова) — это однозначно сильный инфо-триггер.
  const strongInfoTerms = Array.isArray(scoring.strongInformational)
    ? scoring.strongInformational.map(_norm)
    : [];
  const hasStrongInfo = strongInfoTerms.some((t) => _termHit(q, t))
                     || _startsWithQuestion(q);

  // Шаг 3: сильные транзакционные триггеры (тоже из конфига).
  const strongTxTerms = Array.isArray(scoring.strongTransactional)
    ? scoring.strongTransactional.map(_norm)
    : [];
  const hasStrongTx = strongTxTerms.some((t) => _termHit(q, t));

  // Шаг 4: считаем score по каждой категории.
  const W = scoring.weights || _defaultScoring().weights;
  const scores = { transactional: 0, commercial: 0, investigation: 0, informational: 0, navigational: 0, other: 0 };

  if (matched.transactional.length) {
    scores.transactional += hasStrongTx ? W.transactionalStrong : W.transactionalBase;
  }
  if (matched.commercial.length) {
    scores.commercial += hasStrongInfo ? W.commercialDampened : W.commercialBase;
  }
  if (matched.investigation.length) {
    scores.investigation += hasStrongInfo ? W.investigationDampened : W.investigationBase;
  }
  if (matched.informational.length) {
    scores.informational += hasStrongInfo ? W.informationalStrong : W.informationalWeak;
  }
  if (matched.navigational.length) {
    scores.navigational += W.navigationalBase;
  }

  // Шаг 5: выбор победителя — по убыванию score, тай-брейк по приоритету.
  const PRIORITY = ['transactional', 'commercial', 'investigation', 'informational', 'navigational'];
  let best = 'other';
  let bestScore = 0;
  for (const k of PRIORITY) {
    if (scores[k] > bestScore) { best = k; bestScore = scores[k]; }
  }

  const intent = best;
  const matchedTerms = [].concat(
    matched.transactional, matched.commercial, matched.investigation,
    matched.informational, matched.navigational,
  ).slice(0, 8);
  const maxPossible = Math.max(W.transactionalStrong, W.informationalStrong, W.commercialBase) * 2;
  const confidence = bestScore > 0 ? Math.min(1, _round(bestScore / maxPossible, 2)) : 0;

  return {
    intent,
    branded,
    commercial: COMMERCIAL_INTENTS.includes(intent),
    confidence,
    signals: { matched: matchedTerms, scores },
  };
}

/** Хелпер: сработал ли терм по правилам словаря (см. _dictHit). */
function _termHit(normQuery, term) {
  const t = _norm(term);
  if (!t) return false;
  if (t.includes(' ')) return normQuery.includes(t);
  return _wordHit(normQuery, t);
}

/** Сильный информационный триггер «вопросительное начало» — первые 2 слова. */
function _startsWithQuestion(normQuery) {
  if (!normQuery) return false;
  const head = normQuery.split(/[^a-zа-я0-9]+/i).slice(0, 2).join(' ');
  // Однословные: «как», «почему», «зачем», «когда», «где», «сколько».
  // Двусловные: «что такое».
  if (/^что такое\b/.test(head)) return true;
  if (/^(как|почему|зачем|когда|где|сколько)\b/.test(head)) return true;
  if (/^(how|what|why|when|where)\b/.test(head)) return true;
  return false;
}

function _defaultScoring() {
  return {
    weights: {
      transactionalStrong: 3,
      transactionalBase:   2,
      commercialBase:      2,
      commercialDampened:  1,
      investigationBase:   2,
      investigationDampened: 1,
      informationalStrong: 3,
      informationalWeak:   1,
      navigationalBase:    2,
    },
    // Сильные информационные триггеры (вопросительные / how-to).
    strongInformational: [
      'что такое', 'что это', 'как', 'почему', 'зачем', 'когда', 'где',
      'сколько', 'инструкция', 'руководство', 'гайд', 'мануал', 'пошагово',
      'своими руками', 'пример', 'примеры', 'виды', 'типы', 'причины',
      'определение', 'значение', 'история',
      'how', 'what', 'why', 'guide', 'tutorial', 'meaning', 'examples',
    ],
    // Сильные транзакционные триггеры (покупка/оплата/доставка).
    strongTransactional: [
      'купить', 'куплю', 'заказать', 'заказ', 'оформить заказ', 'цена',
      'цены', 'стоимость', 'сколько стоит', 'прайс', 'прайс-лист',
      'скидка', 'скидки', 'акция', 'акции', 'распродажа', 'промокод',
      'доставка', 'доставкой', 'оплата', 'в рассрочку', 'рассрочка',
      'купить онлайн', 'интернет-магазин',
      'buy', 'order', 'price', 'cost', 'shop', 'for sale',
    ],
  };
}

function _dictHit(normQuery, list) {
  if (!Array.isArray(list)) return false;
  for (const term of list) {
    const t = _norm(term);
    if (!t) continue;
    // Многословные термины — по подстроке; одиночные — по границе слова.
    if (t.includes(' ')) { if (normQuery.includes(t)) return true; }
    else if (_wordHit(normQuery, t)) return true;
  }
  return false;
}

// Совпадение по границе слова (без regexp на пользовательском вводе —
// защита от ReDoS: ручной разбор по не-буквенно-цифровым разделителям).
function _wordHit(normQuery, term) {
  if (!term) return false;
  let idx = normQuery.indexOf(term);
  while (idx !== -1) {
    const before = idx === 0 ? '' : normQuery[idx - 1];
    const after = normQuery[idx + term.length] || '';
    if (!_isWordChar(before) && !_isWordChar(after)) return true;
    idx = normQuery.indexOf(term, idx + 1);
  }
  return false;
}

function _isWordChar(ch) {
  return !!ch && /[a-zа-я0-9]/i.test(ch);
}

function _expectedCtr(position, benchmark) {
  const pos = Math.max(1, Math.round(Number(position) || 0));
  if (benchmark[pos] != null) return benchmark[pos];
  // За пределами таблицы — затухающий хвост.
  if (pos > 10) return Math.max(0.005, 0.022 * (10 / pos));
  return 0.02;
}

function _pageIsInfo(page, markers) {
  const p = _norm(page);
  return markers.some((m) => p.includes(m));
}

function _pageIsCommerce(page, markers) {
  const p = _norm(page);
  return markers.some((m) => p.includes(m));
}

/**
 * Грубая классификация лендинга по URL-маркерам (ТЗ §4).
 * Возвращает 'commerce' | 'info' | 'unknown'. Коммерческие маркеры
 * проверяются первыми: каталог/товар/категория/услуги — это коммерция,
 * даже если URL содержит, например, '/blog' как фрагмент. Если ни одна
 * группа маркеров не сработала — 'unknown'.
 */
function classifyLanding(url, cfgOverride) {
  if (!url) return 'unknown';
  const cfg = cfgOverride || getProjectsConfig().commercial;
  const commerceMarkers = cfg.commercePageMarkers || [];
  const infoMarkers     = cfg.infoPageMarkers || [];
  if (_pageIsCommerce(url, commerceMarkers)) return 'commerce';
  if (_pageIsInfo(url, infoMarkers))         return 'info';
  return 'unknown';
}

/**
 * Финальный интент пары query × page (ТЗ §4): объединяем словарный интент
 * запроса с типом лендинга. Матрица:
 *
 *   transactional/commercial × commerce  → commercial
 *   transactional/commercial × info      → intent_mismatch (отдельный сигнал)
 *   investigation            × commerce  → commercial   (deal-ready трафик)
 *   investigation            × info      → informational (обзорная статья)
 *   informational            × *         → informational
 *   navigational             × *         → navigational
 *   other                    × *         → other
 *   * (любое)                × unknown   → по query intent
 */
function combinedIntent(queryIntent, landing) {
  const qi = queryIntent || 'other';
  if (landing === 'unknown') return qi;
  if (qi === 'transactional' || qi === 'commercial') {
    return landing === 'commerce' ? qi : 'intent_mismatch';
  }
  if (qi === 'investigation') {
    return landing === 'commerce' ? 'commercial' : 'informational';
  }
  return qi;
}

/**
 * Главная функция. Строит коммерческий срез из данных GSC.
 *
 * @param {Object} params
 *   topQueries  [{key,clicks,impressions,ctr,position}]  (ctr в процентах)
 *   topPages    [{key,...}]
 *   queryPage   [{query,page,clicks,impressions,ctr,position}] (опционально)
 *   brandTokens string[]
 * @returns {Object} безопасный срез (никогда не бросает)
 */
function analyzeCommercial(params = {}) {
  const cfg = getProjectsConfig().commercial;
  const brandTokens = Array.isArray(params.brandTokens) ? params.brandTokens : [];
  const topQueries = Array.isArray(params.topQueries) ? params.topQueries : [];
  const queryPage = Array.isArray(params.queryPage) ? params.queryPage : [];

  // 0) Подготовка: по queryPage понимаем, на какую страницу чаще всего
  // приземляется каждый запрос — это нужно для combinedIntent (ТЗ §4),
  // который различает «коммерческий запрос на коммерческой странице»
  // и «коммерческий запрос на инфо-странице».
  const queryDominantLanding = new Map(); // normQuery → 'commerce'|'info'|'unknown'
  if (queryPage.length) {
    const tally = new Map(); // normQuery → { commerce, info, unknown } по кликам
    for (const r of queryPage) {
      const k = _norm(r.query);
      if (!k) continue;
      const landing = classifyLanding(r.page, cfg);
      const w = (Number(r.clicks) || 0) + (Number(r.impressions) || 0) * 0.001;
      if (!tally.has(k)) tally.set(k, { commerce: 0, info: 0, unknown: 0 });
      tally.get(k)[landing] += w || 0.001;
    }
    for (const [k, v] of tally.entries()) {
      let best = 'unknown'; let bestW = -1;
      for (const land of ['commerce', 'info', 'unknown']) {
        if (v[land] > bestW) { best = land; bestW = v[land]; }
      }
      queryDominantLanding.set(k, best);
    }
  }

  // 1) Классификация + распределение по интентам (с учётом combined).
  const buckets = {};
  const ensure = (k) => (buckets[k] || (buckets[k] = { intent: k, queries: 0, clicks: 0, impressions: 0 }));
  let brandedClicks = 0;
  let totalClicks = 0;
  let totalImpr = 0;
  let commClicks = 0;
  let commImpr = 0;

  const classified = topQueries.map((r) => {
    const c = classifyQuery(r.key, { brandTokens, dictionaries: cfg.dictionaries });
    const landing = queryDominantLanding.get(_norm(r.key)) || 'unknown';
    const combined = combinedIntent(c.intent, landing);
    // Для UI-распределения используем «дружелюбный» интент: intent_mismatch
    // схлопываем в исходный коммерческий интент запроса, чтобы клиент видел
    // его в коммерческом ведре, а флаг mismatch — в отдельной таблице.
    const distIntent = combined === 'intent_mismatch' ? c.intent : combined;
    const clicks = Number(r.clicks) || 0;
    const impr = Number(r.impressions) || 0;
    const b = ensure(distIntent);
    b.queries += 1; b.clicks += clicks; b.impressions += impr;
    totalClicks += clicks; totalImpr += impr;
    if (c.branded) brandedClicks += clicks;
    // Коммерческой считаем строго combined-интент (а не «сырая классификация»).
    const isCommercial = combined !== 'intent_mismatch' && COMMERCIAL_INTENTS.includes(combined);
    if (isCommercial) { commClicks += clicks; commImpr += impr; }
    return {
      ...r,
      intent: c.intent,
      intent_confidence: c.confidence,
      intent_signals: c.signals,
      landing,
      combined_intent: combined,
      branded: c.branded,
      commercial: isCommercial,
    };
  });

  const intentDistribution = Object.values(buckets)
    .map((b) => ({
      intent: b.intent,
      queries: b.queries,
      clicks: b.clicks,
      impressions: b.impressions,
      clicksPct: totalClicks ? _round((b.clicks / totalClicks) * 100, 1) : 0,
    }))
    .sort((a, b) => b.clicks - a.clicks);

  // 2) Striking distance — коммерческие запросы у входа в топ.
  const sd = cfg.strikingDistance;
  const strikingDistance = classified
    .filter((r) => r.commercial
      && r.position >= sd.minPosition && r.position <= sd.maxPosition
      && (Number(r.impressions) || 0) >= sd.minImpressions)
    .sort((a, b) => (b.impressions - a.impressions))
    .slice(0, cfg.topOpportunities)
    .map((r) => ({
      query: r.key, intent: r.intent,
      clicks: r.clicks, impressions: r.impressions,
      ctr: r.ctr, position: r.position,
    }));

  // 3) CTR-аномалии — топовые позиции с CTR заметно ниже бенчмарка.
  const an = cfg.ctrAnomaly;
  const ctrAnomalies = classified
    .filter((r) => r.commercial
      && r.position <= an.maxPosition
      && (Number(r.impressions) || 0) >= an.minImpressions)
    .map((r) => {
      const expectedPct = _round(_expectedCtr(r.position, cfg.ctrBenchmark) * 100, 2);
      return { ...r, expectedCtr: expectedPct };
    })
    .filter((r) => r.expectedCtr > 0 && (Number(r.ctr) || 0) <= r.expectedCtr * an.dropRatio)
    .sort((a, b) => (b.impressions - a.impressions))
    .slice(0, cfg.topOpportunities)
    .map((r) => ({
      query: r.key, intent: r.intent,
      clicks: r.clicks, impressions: r.impressions,
      ctr: r.ctr, expectedCtr: r.expectedCtr, position: r.position,
    }));

  // 4) Каннибализация + несоответствие интента — из среза query × page.
  const { cannibalization, intentMismatch } = _analyzeQueryPage(queryPage, brandTokens, cfg);

  // 5) Группировка страниц по интенту (ТЗ §4): для каждой страницы
  // суммируем клики по combined_intent её запросов и выбираем
  // мажоритарный (порог 60%), иначе — 'mixed'. Помогает увидеть,
  // какие страницы реально работают на коммерцию, а какие — на инфо.
  const pagesByIntent = _aggregatePagesByIntent(queryPage, brandTokens, cfg);

  const commercialClicksPct = totalClicks ? _round((commClicks / totalClicks) * 100, 1) : 0;
  const commercialImprPct = totalImpr ? _round((commImpr / totalImpr) * 100, 1) : 0;
  const brandedClicksPct = totalClicks ? _round((brandedClicks / totalClicks) * 100, 1) : 0;

  return {
    available: classified.length > 0,
    brand_tokens: brandTokens,
    totals: {
      analyzed_queries: classified.length,
      clicks: totalClicks,
      impressions: totalImpr,
    },
    commercial_clicks_pct: commercialClicksPct,
    commercial_impressions_pct: commercialImprPct,
    branded_clicks_pct: brandedClicksPct,
    intent_distribution: intentDistribution,
    striking_distance: strikingDistance,
    ctr_anomalies: ctrAnomalies,
    cannibalization,
    intent_mismatch: intentMismatch,
    pages_by_intent: pagesByIntent,
  };
}

/**
 * Группировка страниц по доминирующему combined_intent (ТЗ §4).
 * Возвращает массив { page, landing, dominant_intent, share, clicks,
 * impressions, by_intent: {commercial,informational,...} }, отсортированный
 * по убыванию кликов. Дополнительно — summary с долями.
 */
function _aggregatePagesByIntent(queryPage, brandTokens, cfg) {
  if (!Array.isArray(queryPage) || !queryPage.length) {
    return { items: [], summary: { commercial: 0, informational: 0, mixed: 0, other: 0 } };
  }
  const byPage = new Map();
  for (const r of queryPage) {
    const page = r.page;
    if (!page) continue;
    const c = classifyQuery(r.query, { brandTokens, dictionaries: cfg.dictionaries });
    const landing = classifyLanding(page, cfg);
    const combined = combinedIntent(c.intent, landing);
    const distIntent = combined === 'intent_mismatch' ? c.intent : combined;
    const clicks = Number(r.clicks) || 0;
    const impr = Number(r.impressions) || 0;
    if (!byPage.has(page)) {
      byPage.set(page, { page, landing, clicks: 0, impressions: 0, by_intent: {} });
    }
    const entry = byPage.get(page);
    entry.clicks += clicks;
    entry.impressions += impr;
    entry.by_intent[distIntent] = (entry.by_intent[distIntent] || 0) + clicks;
  }

  const items = [];
  for (const entry of byPage.values()) {
    let dominant = 'other'; let dominantClicks = 0;
    for (const [k, v] of Object.entries(entry.by_intent)) {
      if (v > dominantClicks) { dominant = k; dominantClicks = v; }
    }
    const share = entry.clicks > 0 ? dominantClicks / entry.clicks : 0;
    // Порог 60% — иначе помечаем страницу как mixed.
    const dominantIntent = share >= 0.6 ? dominant : 'mixed';
    items.push({
      page: entry.page,
      landing: entry.landing,
      clicks: entry.clicks,
      impressions: entry.impressions,
      dominant_intent: dominantIntent,
      dominant_share: _round(share, 2),
      by_intent: entry.by_intent,
    });
  }

  items.sort((a, b) => b.clicks - a.clicks);

  // Summary: сколько страниц/кликов попали в коммерческое/инфо/смешанное ведро.
  const summary = { commercial: 0, informational: 0, navigational: 0, mixed: 0, other: 0 };
  let totalClicks = 0;
  for (const it of items) {
    totalClicks += it.clicks;
    if (it.dominant_intent === 'transactional' || it.dominant_intent === 'commercial' || it.dominant_intent === 'investigation') {
      summary.commercial += it.clicks;
    } else if (it.dominant_intent === 'informational') {
      summary.informational += it.clicks;
    } else if (it.dominant_intent === 'navigational') {
      summary.navigational += it.clicks;
    } else if (it.dominant_intent === 'mixed') {
      summary.mixed += it.clicks;
    } else {
      summary.other += it.clicks;
    }
  }
  const summaryPct = {};
  for (const [k, v] of Object.entries(summary)) {
    summaryPct[k] = totalClicks ? _round((v / totalClicks) * 100, 1) : 0;
  }

  return {
    items: items.slice(0, cfg.topOpportunities * 3 || 60),
    summary,
    summary_pct: summaryPct,
  };
}

function _analyzeQueryPage(queryPage, brandTokens, cfg) {
  const cannibalization = [];
  const intentMismatch = [];
  if (!Array.isArray(queryPage) || queryPage.length === 0) {
    return { cannibalization, intentMismatch };
  }

  // Группируем по нормализованному запросу.
  // ТЗ §4: «фокус на коммерции» теперь решается через query intent (а не
  // combined), потому что цель этого блока — найти каннибализацию и
  // mismatch ИМЕННО среди коммерчески сильных запросов; landing мы здесь
  // оцениваем отдельно ниже.
  const byQuery = new Map();
  for (const r of queryPage) {
    const c = classifyQuery(r.query, { brandTokens, dictionaries: cfg.dictionaries });
    // На уровне query: пропускаем только явно информационные/навигационные,
    // оставляем transactional/commercial/investigation — они и есть «фокус
    // на коммерции». investigation добавляем, потому что «отзывы X», «обзор
    // X» — это deal-ready трафик, mismatch на инфо-странице тоже важен.
    if (!COMMERCIAL_INTENTS.includes(c.intent)) continue;
    const key = _norm(r.query);
    if (!byQuery.has(key)) byQuery.set(key, { query: r.query, intent: c.intent, rows: [] });
    byQuery.get(key).rows.push({
      page: r.page,
      clicks: Number(r.clicks) || 0,
      impressions: Number(r.impressions) || 0,
      ctr: Number(r.ctr) || 0,
      position: Number(r.position) || 0,
    });
  }

  for (const entry of byQuery.values()) {
    const rows = entry.rows;
    // 4a) Каннибализация: один коммерческий запрос → ≥2 страницы и ни одна
    // не в топ-3 (конкуренция своих же URL мешает выйти в топ).
    if (rows.length >= 2) {
      const bestPos = Math.min(...rows.map((x) => x.position || 999));
      if (bestPos > 3) {
        cannibalization.push({
          query: entry.query,
          intent: entry.intent,
          pages: rows
            .sort((a, b) => b.impressions - a.impressions)
            .slice(0, 5)
            .map((x) => ({ page: x.page, clicks: x.clicks, impressions: x.impressions, position: _round(x.position, 1) })),
          best_position: _round(bestPos, 1),
        });
      }
    }
    // 4b) Несоответствие интента: коммерческий запрос приземляется на
    // инфо-страницу (блог/статья), а коммерческой страницы в выдаче нет.
    const top = rows.slice().sort((a, b) => b.clicks - a.clicks)[0];
    if (top && _pageIsInfo(top.page, cfg.infoPageMarkers)
      && !rows.some((x) => _pageIsCommerce(x.page, cfg.commercePageMarkers))) {
      intentMismatch.push({
        query: entry.query,
        intent: entry.intent,
        landing_page: top.page,
        clicks: top.clicks,
        impressions: top.impressions,
        position: _round(top.position, 1),
      });
    }
  }

  cannibalization.sort((a, b) => {
    const ai = a.pages.reduce((s, p) => s + p.impressions, 0);
    const bi = b.pages.reduce((s, p) => s + p.impressions, 0);
    return bi - ai;
  });
  intentMismatch.sort((a, b) => b.impressions - a.impressions);

  return {
    cannibalization: cannibalization.slice(0, cfg.topOpportunities),
    intentMismatch: intentMismatch.slice(0, cfg.topOpportunities),
  };
}

module.exports = {
  classifyQuery,
  classifyLanding,
  combinedIntent,
  deriveBrandTokens,
  analyzeCommercial,
  COMMERCIAL_INTENTS,
  _expectedCtr,
};
