'use strict';

/**
 * forecaster/keyssoClient.js — тонкий HTTP-клиент keys.so для прогнозатора.
 *
 * Назначение: по списку фраз и домену вернуть фактические сигналы из выдачи:
 *   • current_position (1..200, 0 = не найдено)
 *   • top10_competition (per-фраза keys.so по этому endpoint-у не отдаёт,
 *     оставляем null — медиана конкуренции тогда тоже null → пайплайн
 *     трактует это как «unknown» и не штрафует прогноз)
 *   • demand_index    — частотность (wsk «!очень !точная», fallback ws)
 *   • position_3m_delta — `delta` поля API (положительное число обычно
 *     означает улучшение позиции)
 *
 * Эти данные нужны прогнозатору, чтобы вместо плоского defaultCurrentCtr
 * (≈ позиция 20+) использовать реальные позиции; домножать realisticShareTopN
 * на competition_factor (≤1.0); и сжимать верхнюю границу CI прогноза при
 * negative momentum (см. traffic.competitionAdjustment / momentumCiAdjust в
 * config.js).
 *
 * Реальный API keys.so (см. /openapi.json в корне репо):
 *   GET https://api.keys.so/report/simple/organic/keywords
 *       ?base=<base>&domain=<domain>&page=<n>&per_page=<n>&sort=pos|asc
 *   Заголовок авторизации: X-Keyso-TOKEN: <key>
 *   Ответ:
 *     {
 *       current_page, per_page, last_page, total,
 *       data: [ { word, url, pos, ws, wsk, delta, ... }, ... ]
 *     }
 *
 * Поскольку endpoint не принимает список фраз на вход, мы вытягиваем
 * органическую выдачу домена постранично (сорт по позиции asc — «лучшие
 * сверху»), затем пересекаем с requested-набором.
 *
 * Гейты:
 *   • feature flag — getForecasterConfig().keysso.enabled
 *   • ключ — process.env.KEYSSO_API_KEY. Если ключа нет —
 *     fetchPhraseSignals возвращает { verdict: 'skipped', reason: 'no_api_key' },
 *     пайплайн продолжает работу без сигналов.
 *
 * Все сетевые ошибки graceful: timeouts/4xx/5xx → { verdict: 'error', reason }.
 * Никаких exception наружу.
 *
 * Кэш — in-memory LRU+TTL по hash(base|domain). Один ключ кэша = полный
 * Map ключей домена; TTL по умолчанию 24 ч.
 */

const crypto = require('crypto');
const { getForecasterConfig } = require('./config');

// ── Region label → keys.so base code ──────────────────────────────────
//
// keys.so принимает короткие коды баз (msk, spb, gru, …). Пользователь
// в форме «Регион / комментарий» вводит произвольный текст. Здесь —
// минимальный mapping ходовых обозначений. Если ничего не подошло —
// fallback на defaultRegion из config.
//
// Полный список (schemas.base в openapi.json):
//   msk gru zen gkv rnd ekb ufa sar krr prm sam kry oms kzn che nsk
//   nnv vlg vrn spb mns tmn gmns tom gny
const _BASE_CODES = new Set([
  'msk', 'gru', 'zen', 'gkv', 'rnd', 'ekb', 'ufa', 'sar', 'krr', 'prm',
  'sam', 'kry', 'oms', 'kzn', 'che', 'nsk', 'nnv', 'vlg', 'vrn', 'spb',
  'mns', 'tmn', 'gmns', 'tom', 'gny',
]);

const _REGION_ALIASES = {
  // Россия (агрегата нет) → берём Яндекс: Москва как столичный регион
  'россия':                      'msk',
  'russia':                      'msk',
  'ru':                          'msk',
  'рф':                          'msk',
  // Москва
  'москва':                      'msk',
  'moscow':                      'msk',
  'мск':                         'msk',
  // Google Москва
  'google':                      'gru',
  'google москва':               'gru',
  'google moscow':               'gru',
  // Санкт-Петербург
  'санкт-петербург':             'spb',
  'санкт петербург':             'spb',
  'спб':                         'spb',
  'питер':                       'spb',
  'saint-petersburg':            'spb',
  'st petersburg':               'spb',
  // Остальные крупные города
  'екатеринбург':                'ekb',
  'новосибирск':                 'nsk',
  'нижний новгород':             'nnv',
  'казань':                      'kzn',
  'самара':                      'sam',
  'ростов-на-дону':              'rnd',
  'ростов на дону':              'rnd',
  'краснодар':                   'krr',
  'воронеж':                     'vrn',
  'волгоград':                   'vlg',
  'пермь':                       'prm',
  'уфа':                         'ufa',
  'саратов':                     'sar',
  'красноярск':                  'kry',
  'омск':                        'oms',
  'челябинск':                   'che',
  'томск':                       'tom',
  'тюмень':                      'tmn',
  'минск':                       'mns',
  'киев':                        'gkv',
  'kiev':                        'gkv',
  'kyiv':                        'gkv',
};

function _resolveBase(region, fallback) {
  const raw = String(region || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (_BASE_CODES.has(raw)) return raw;
  const alias = _REGION_ALIASES[raw];
  if (alias) return alias;
  return fallback;
}

// ── In-memory LRU + TTL cache (ключ = base+domain) ────────────────────

const _cache = new Map(); // key → { value: Map<phrase, signals>, expiresAt }

function _cacheKey({ base, domain }) {
  const norm = JSON.stringify({
    b: String(base   || '').trim().toLowerCase(),
    d: String(domain || '').trim().toLowerCase(),
  });
  return crypto.createHash('sha1').update(norm).digest('hex');
}

function _cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) {
    _cache.delete(key);
    return null;
  }
  // Move-to-head
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.value;
}

function _cacheSet(key, value, ttlMs, maxEntries) {
  if (_cache.size >= maxEntries) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function _cacheClear() { _cache.clear(); }
function _cacheSize()  { return _cache.size; }

// ── Helpers ───────────────────────────────────────────────────────────

function _hostFromUrl(u) {
  try {
    if (!u) return '';
    let s = String(u).trim();
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return new URL(s).hostname.replace(/^www\./i, '').toLowerCase();
  } catch (_) { return ''; }
}

function _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function _normalizePhrase(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── HTTP ──────────────────────────────────────────────────────────────

async function _httpGetJson({ url, headers, timeoutMs, fetchImpl }) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('global fetch not available (Node ≥ 18 required)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await f(url, {
      method:  'GET',
      headers: { Accept: 'application/json', ...headers },
      signal:  ctrl.signal,
    });
    const text = await resp.text();
    let json;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (!resp.ok) {
      const err = new Error(`keys.so http ${resp.status}: ${(text || '').slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Парсит одну страницу /report/simple/organic/keywords в Map<phrase, signals>.
 * Поля API (см. openapi.json):
 *   word    — ключевая фраза
 *   pos     — позиция (0 = не в выдаче)
 *   ws      — базовая частотность
 *   wsk     — «!очень !точная» частотность (предпочтительнее)
 *   delta   — изменение позиции
 */
function _parsePage(json) {
  const out = new Map();
  if (!json || typeof json !== 'object') return out;
  const arr = Array.isArray(json.data) ? json.data : [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const phrase = _normalizePhrase(it.word ?? it.keyword ?? it.kw ?? it.phrase);
    if (!phrase) continue;
    const posRaw = Number(it.pos ?? it.position ?? 0);
    const pos    = Number.isFinite(posRaw) && posRaw > 0
      ? Math.min(200, Math.round(posRaw))
      : 0;
    const freqRaw = Number(it.wsk ?? it.ws ?? it.frequency ?? it.freq ?? 0);
    const freq    = Number.isFinite(freqRaw) && freqRaw > 0 ? freqRaw : 0;
    const deltaRaw = Number(it.delta ?? it.position_3m_delta ?? it.trend ?? 0);
    const delta    = Number.isFinite(deltaRaw) ? deltaRaw : 0;
    out.set(phrase, {
      current_position:   pos,
      // keys.so в этом эндпоинте не отдаёт per-keyword competition —
      // оставляем null, чтобы aggregateSignals пометил medianas как unknown
      // и не штрафовал прогноз (см. trafficModel.competitionAdjustment).
      top10_competition:  null,
      demand_index:       freq,
      position_3m_delta:  delta,
    });
  }
  return out;
}

/**
 * Тянет все страницы органической выдачи домена до cfg.maxFetchKeywords
 * либо последней страницы. Возвращает Map<normPhrase, signals>.
 * Сетевые ошибки на отдельных страницах — graceful: warn + продолжаем.
 */
async function _fetchDomainKeywords({
  apiBase, apiKey, base, domain, perPage, maxFetchKeywords,
  pageDelayMs, timeoutMs, fetchImpl,
}) {
  const allSignals = new Map();
  const baseUrl = `${apiBase.replace(/\/+$/, '')}/report/simple/organic/keywords`;
  const headers = { 'X-Keyso-TOKEN': apiKey };

  let page = 1;
  // sort=pos|asc → начинаем с лучших позиций; для отчёта так информативнее.
  const sort = 'pos|asc';
  // Hard-cap страниц на случай нестандартных ответов (защита от runaway).
  const hardMaxPages = Math.max(1, Math.ceil(maxFetchKeywords / Math.max(1, perPage)) + 2);

  while (page <= hardMaxPages && allSignals.size < maxFetchKeywords) {
    const qs = new URLSearchParams({
      base,
      domain,
      page:     String(page),
      per_page: String(perPage),
      sort,
    }).toString();
    const url = `${baseUrl}?${qs}`;
    let json;
    try {
      json = await _httpGetJson({ url, headers, timeoutMs, fetchImpl });
    } catch (err) {
      console.warn(`[keysso] page ${page} failed: ${err.message}`);
      // На первой странице ошибка → бросаем выше, чтобы пайплайн
      // отметил verdict='error'. На последующих — обрываем пагинацию,
      // оставляем то, что уже собрали.
      if (page === 1) throw err;
      break;
    }
    const pageMap = _parsePage(json);
    for (const [ph, sig] of pageMap) {
      if (!allSignals.has(ph)) allSignals.set(ph, sig);
      if (allSignals.size >= maxFetchKeywords) break;
    }
    const lastPage    = Number(json && json.last_page) || 0;
    const currentPage = Number(json && json.current_page) || page;
    const gotRows     = pageMap.size;
    if (gotRows === 0)              break; // ничего нового
    if (lastPage > 0 && currentPage >= lastPage) break;
    page = currentPage + 1;
    if (pageDelayMs > 0) await _sleep(pageDelayMs);
  }
  return allSignals;
}

// ── Public: fetchPhraseSignals ────────────────────────────────────────

/**
 * Возвращает сигналы keys.so для списка фраз.
 *
 * @param {Object} args
 * @param {Array<string>} args.phrases   список фраз (top-N от пайплайна)
 * @param {string} args.domain           домен (например, "example.com")
 * @param {string} [args.region]         произвольный текст, маппится в base
 * @param {Function} [args.fetchImpl]    переопределение fetch (для тестов)
 * @returns {Promise<{
 *   verdict: 'ok'|'skipped'|'error',
 *   reason?: string,
 *   signals?: Map<string, {current_position, top10_competition, demand_index, position_3m_delta}>,
 *   requested?: number,
 *   matched?:   number,
 *   cache_hits?: number,
 *   duration_ms?: number,
 * }>}
 */
async function fetchPhraseSignals({
  phrases, domain, region, fetchImpl,
} = {}) {
  const cfg = getForecasterConfig().keysso;
  if (!cfg || !cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };

  const apiKey = process.env.KEYSSO_API_KEY || process.env.KEYS_SO_API_KEY;
  if (!apiKey) return { verdict: 'skipped', reason: 'no_api_key' };

  const dom = _hostFromUrl(domain) || String(domain || '').trim().toLowerCase();
  if (!dom) return { verdict: 'skipped', reason: 'no_domain' };

  const list = Array.isArray(phrases) ? phrases.filter(Boolean) : [];
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_phrases' };

  const base = _resolveBase(region, cfg.defaultRegion || 'msk');
  const trimmed = list.slice(0, cfg.maxPhrasesPerTask);

  const t0 = Date.now();
  let cacheHits = 0;

  // Один кэш-ключ = весь набор ключей домена для данной базы.
  const ckey = _cacheKey({ base, domain: dom });
  let domainMap = _cacheGet(ckey);
  if (domainMap) {
    cacheHits = domainMap.size;
  } else {
    try {
      domainMap = await _fetchDomainKeywords({
        apiBase:          cfg.apiBase,
        apiKey,
        base,
        domain:           dom,
        perPage:          cfg.perPage,
        maxFetchKeywords: cfg.maxFetchKeywords,
        pageDelayMs:      cfg.pageDelayMs,
        timeoutMs:        cfg.timeoutMs,
        fetchImpl,
      });
    } catch (err) {
      return {
        verdict:     'error',
        reason:      (err && err.message) || String(err),
        requested:   trimmed.length,
        matched:     0,
        cache_hits:  0,
        duration_ms: Date.now() - t0,
        domain:      dom,
        region:      base,
      };
    }
    _cacheSet(ckey, domainMap, cfg.cacheTtlMs, cfg.cacheMaxEntries);
  }

  // Пересечение с запрошенным списком.
  const signals = new Map();
  for (const p of trimmed) {
    const norm = _normalizePhrase(p);
    if (!norm) continue;
    const sig = domainMap.get(norm);
    if (sig) signals.set(norm, sig);
  }

  return {
    verdict:     'ok',
    signals,
    requested:   trimmed.length,
    matched:     signals.size,
    cache_hits:  cacheHits,
    duration_ms: Date.now() - t0,
    domain:      dom,
    region:      base,
  };
}

// ── Aggregate signals over portfolio ──────────────────────────────────

/**
 * Сводит Map<phrase, signals> в портфельные агрегаты для прогноза и UI:
 *   • avg_current_position (среднее по фразам, где position>0)
 *   • phrases_in_top10_pct / phrases_in_top30_pct / phrases_off_top50_pct
 *   • median_competition   (медиана top10_competition; null если данных нет)
 *   • momentum             ('positive'|'neutral'|'negative')
 *
 * @param {Map<string, Object>} signals
 * @param {number} totalRequested
 */
function aggregateSignals(signals, totalRequested) {
  const out = {
    requested:           Number(totalRequested) || 0,
    matched:             signals ? signals.size : 0,
    avg_current_position: null,
    phrases_in_top10_pct: 0,
    phrases_in_top30_pct: 0,
    phrases_off_top50_pct: 0,
    median_competition:  null,
    momentum:            'neutral',
    momentum_delta_avg:  0,
  };
  if (!signals || signals.size === 0) return out;

  const positions = [];
  const comps     = [];
  const deltas    = [];
  let inTop10 = 0;
  let inTop30 = 0;
  let offTop50 = 0;

  for (const s of signals.values()) {
    const p = Number(s.current_position || 0);
    if (p > 0) positions.push(p);
    if (p > 0 && p <= 10) inTop10 += 1;
    if (p > 0 && p <= 30) inTop30 += 1;
    if (p === 0 || p > 50) offTop50 += 1;
    if (s.top10_competition !== null && s.top10_competition !== undefined &&
        Number(s.top10_competition) >= 0) {
      comps.push(Number(s.top10_competition));
    }
    deltas.push(Number(s.position_3m_delta || 0));
  }
  if (positions.length > 0) {
    out.avg_current_position = Math.round(
      (positions.reduce((a, b) => a + b, 0) / positions.length) * 10,
    ) / 10;
  }
  const matched = Math.max(1, signals.size);
  out.phrases_in_top10_pct  = Math.round((inTop10  / matched) * 1000) / 10;
  out.phrases_in_top30_pct  = Math.round((inTop30  / matched) * 1000) / 10;
  out.phrases_off_top50_pct = Math.round((offTop50 / matched) * 1000) / 10;

  if (comps.length > 0) {
    const sorted = [...comps].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    out.median_competition = sorted.length % 2
      ? sorted[mid]
      : Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 1000) / 1000;
  }
  if (deltas.length > 0) {
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    // delta > 0 — позиция РОСЛА (улучшилась). Если API даст обратное —
    // адаптируйте в _parsePage.
    out.momentum_delta_avg = Math.round(avg * 100) / 100;
    if (avg > 0.5)       out.momentum = 'positive';
    else if (avg < -0.5) out.momentum = 'negative';
    else                 out.momentum = 'neutral';
  }
  return out;
}

module.exports = {
  fetchPhraseSignals,
  aggregateSignals,
  // internals (для тестов)
  _cacheKey,
  _cacheGet,
  _cacheSet,
  _cacheClear,
  _cacheSize,
  _parsePage,
  _normalizePhrase,
  _hostFromUrl,
  _resolveBase,
};
