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
 * @param {string} query
 * @param {Object} opts { brandTokens, dictionaries }
 * @returns {{intent:string, branded:boolean, commercial:boolean}}
 */
function classifyQuery(query, opts = {}) {
  const q = _norm(query);
  const dict = opts.dictionaries || getProjectsConfig().commercial.dictionaries;
  const brandTokens = Array.isArray(opts.brandTokens) ? opts.brandTokens : [];

  const branded = brandTokens.length > 0
    && brandTokens.some((t) => t && _wordHit(q, t));

  // Порядок проверки важен: транзакционный/коммерческий/исследовательский
  // выигрывают у информационного, если совпали оба (напр. «как купить»).
  let intent = 'other';
  if (_dictHit(q, dict.transactional)) intent = 'transactional';
  else if (_dictHit(q, dict.commercial)) intent = 'commercial';
  else if (_dictHit(q, dict.investigation)) intent = 'investigation';
  else if (_dictHit(q, dict.informational)) intent = 'informational';
  else if (_dictHit(q, dict.navigational)) intent = 'navigational';

  return {
    intent,
    branded,
    commercial: COMMERCIAL_INTENTS.includes(intent),
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

  // 1) Классификация + распределение по интентам.
  const buckets = {};
  const ensure = (k) => (buckets[k] || (buckets[k] = { intent: k, queries: 0, clicks: 0, impressions: 0 }));
  let brandedClicks = 0;
  let totalClicks = 0;
  let totalImpr = 0;
  let commClicks = 0;
  let commImpr = 0;

  const classified = topQueries.map((r) => {
    const c = classifyQuery(r.key, { brandTokens, dictionaries: cfg.dictionaries });
    const clicks = Number(r.clicks) || 0;
    const impr = Number(r.impressions) || 0;
    const b = ensure(c.intent);
    b.queries += 1; b.clicks += clicks; b.impressions += impr;
    totalClicks += clicks; totalImpr += impr;
    if (c.branded) brandedClicks += clicks;
    if (c.commercial) { commClicks += clicks; commImpr += impr; }
    return { ...r, intent: c.intent, branded: c.branded, commercial: c.commercial };
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
  };
}

function _analyzeQueryPage(queryPage, brandTokens, cfg) {
  const cannibalization = [];
  const intentMismatch = [];
  if (!Array.isArray(queryPage) || queryPage.length === 0) {
    return { cannibalization, intentMismatch };
  }

  // Группируем по нормализованному запросу.
  const byQuery = new Map();
  for (const r of queryPage) {
    const c = classifyQuery(r.query, { brandTokens, dictionaries: cfg.dictionaries });
    if (!c.commercial) continue; // фокус на коммерции
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
  deriveBrandTokens,
  analyzeCommercial,
  COMMERCIAL_INTENTS,
  _expectedCtr,
};
