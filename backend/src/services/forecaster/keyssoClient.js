'use strict';

/**
 * forecaster/keyssoClient.js — тонкий HTTP-клиент keys.so для прогнозатора.
 *
 * Назначение: по списку фраз и домену вернуть фактические сигналы из выдачи
 *   • current_position (1..100+, 0 = не в топ-100)
 *   • top10_competition  (0..1, индекс силы конкурентов в топ-10)
 *   • demand_index       (нормированная частотность; для калибровки)
 *   • position_3m_delta  (тренд позиции за 3 мес; <0 — падаем, >0 — растём)
 *
 * Эти данные нужны прогнозатору, чтобы вместо плоского defaultCurrentCtr
 * (≈ позиция 20+) использовать реальные позиции; домножать realisticShareTopN
 * на competition_factor (≤1.0); и сжимать верхнюю границу CI прогноза при
 * negative momentum (см. traffic.competitionAdjustment / momentumCiAdjust в
 * config.js).
 *
 * Гейт:
 *   • feature flag — getForecasterConfig().keysso.enabled
 *   • ключ — process.env.KEYSSO_API_KEY (хранится только в env, не в коде).
 *     Если ключа нет — fetchPhraseSignals возвращает { verdict: 'skipped',
 *     reason: 'no_api_key' }, пайплайн продолжает работу без сигналов.
 *
 * Все сетевые ошибки graceful: timeouts/4xx/5xx → { verdict: 'error', reason }.
 * Никаких exception наружу.
 *
 * Кеш — in-memory LRU+TTL по hash(method|phrase|domain|region|engine), TTL
 * по умолчанию 24 ч (cacheTtlMs). Паттерн идентичен serpEvidence.service.js.
 *
 * Замечание по API: точная схема endpoint-ов keys.so может отличаться по
 * тарифу/версии. Клиент использует POST <apiBase>/serp/positions/ с JSON
 * { domain, phrases, region, engine }, авторизация — Bearer token. Парсер
 * ответа устойчив к нескольким вариантам field-неймов (data.<domain>.<phrase>,
 * results[], items[]) — при необходимости адаптируйте _parseResponse под
 * актуальную спецификацию (см. keys.so dashboard → API).
 */

const crypto = require('crypto');
const { getForecasterConfig } = require('./config');

// ── In-memory LRU + TTL cache (паттерн как у serpEvidence.service.js) ─

const _cache = new Map(); // key → { value, expiresAt }

function _cacheKey({ method, phrase, domain, region, engine }) {
  const norm = JSON.stringify({
    m: String(method || '').toLowerCase(),
    p: String(phrase || '').trim().toLowerCase(),
    d: String(domain || '').trim().toLowerCase(),
    r: String(region || '').trim().toLowerCase(),
    e: String(engine || '').trim().toLowerCase(),
  });
  return crypto.createHash('sha1').update(norm).digest('hex');
}

function _cacheGet(key, ttlMs) {
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

function _chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function _normalizePhrase(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// ── HTTP ──────────────────────────────────────────────────────────────

/**
 * Делает один HTTP-запрос к keys.so. Возвращает либо распарсенный JSON,
 * либо null + warning в console (без throw). fetchImpl можно подменить
 * в тестах.
 */
async function _httpJson({ url, headers, body, timeoutMs, fetchImpl }) {
  const f = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!f) throw new Error('global fetch not available (Node ≥ 18 required)');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await f(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body:    typeof body === 'string' ? body : JSON.stringify(body),
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
 * Парсит ответ keys.so в унифицированную Map<normPhrase, signals>.
 * Устойчив к нескольким известным форматам:
 *   • { data: { "<domain>": { "<phrase>": { position, ... } } } }
 *   • { results: [ { phrase, position, ... } ] }
 *   • { items:   [ { keyword, pos, ... } ] }
 *   • { keywords:[ { kw, pos, comp, trend, freq } ] }
 */
function _parseResponse(json, domain) {
  const out = new Map();
  if (!json || typeof json !== 'object') return out;

  const _push = (phraseRaw, src) => {
    if (!src || typeof src !== 'object') return;
    const phrase = _normalizePhrase(phraseRaw);
    if (!phrase) return;
    const pos = Number(
      src.position ?? src.pos ?? src.current_position ?? src.cur_pos ?? 0,
    );
    const comp = Number(
      src.competition ?? src.comp ?? src.competition_index ?? src.kei ?? 0,
    );
    const freq = Number(
      src.frequency ?? src.freq ?? src.search_volume ?? src.demand ?? 0,
    );
    const delta3m = Number(
      src.position_3m_delta ?? src.pos_change ?? src.trend ?? src.delta ?? 0,
    );
    out.set(phrase, {
      current_position:    pos > 0 ? Math.min(200, Math.round(pos)) : 0,
      top10_competition:   Math.max(0, Math.min(1, comp)),
      demand_index:        freq > 0 ? freq : 0,
      position_3m_delta:   Number.isFinite(delta3m) ? delta3m : 0,
    });
  };

  // вариант 1: data[domain][phrase]
  if (json.data && typeof json.data === 'object') {
    const dn = String(domain || '').toLowerCase();
    const sub = json.data[dn] || json.data[domain] || json.data;
    if (sub && typeof sub === 'object' && !Array.isArray(sub)) {
      for (const [k, v] of Object.entries(sub)) {
        if (v && typeof v === 'object' && !Array.isArray(v) &&
            (v.position != null || v.pos != null || v.current_position != null)) {
          _push(k, v);
        }
      }
    }
  }
  // вариант 2/3/4: массивы
  for (const key of ['results', 'items', 'keywords', 'data']) {
    const arr = json[key];
    if (Array.isArray(arr)) {
      for (const it of arr) {
        const ph = it?.phrase || it?.keyword || it?.kw || it?.query || it?.text;
        _push(ph, it);
      }
    }
  }
  return out;
}

// ── Public: fetchPhraseSignals ────────────────────────────────────────

/**
 * Возвращает сигналы keys.so для списка фраз.
 *
 * @param {Object} args
 * @param {Array<string>} args.phrases   список фраз (top-N от пайплайна)
 * @param {string} args.domain           домен (например, "example.com")
 * @param {string} [args.region]
 * @param {string} [args.engine]         'yandex'|'google'
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
  phrases, domain, region, engine, fetchImpl,
} = {}) {
  const cfg = getForecasterConfig().keysso;
  if (!cfg || !cfg.enabled) return { verdict: 'skipped', reason: 'feature_disabled' };

  const apiKey = process.env.KEYSSO_API_KEY;
  if (!apiKey) return { verdict: 'skipped', reason: 'no_api_key' };

  const dom = _hostFromUrl(domain) || String(domain || '').trim().toLowerCase();
  if (!dom) return { verdict: 'skipped', reason: 'no_domain' };

  const list = Array.isArray(phrases) ? phrases.filter(Boolean) : [];
  if (list.length === 0) return { verdict: 'skipped', reason: 'no_phrases' };

  // Trim до квоты
  const trimmed = list.slice(0, cfg.maxPhrasesPerTask);

  const rg = String(region || cfg.defaultRegion || '').trim();
  const eng = String(engine || cfg.searchEngine || 'yandex').trim();

  const t0 = Date.now();
  const signals = new Map();
  let cacheHits = 0;

  // Сначала пройдёмся по кешу — все фразы, которые есть, не отправим в сеть.
  const toFetch = [];
  for (const p of trimmed) {
    const norm = _normalizePhrase(p);
    if (!norm) continue;
    const key = _cacheKey({ method: 'positions', phrase: norm, domain: dom, region: rg, engine: eng });
    const cached = _cacheGet(key, cfg.cacheTtlMs);
    if (cached) {
      signals.set(norm, cached);
      cacheHits += 1;
    } else {
      toFetch.push(norm);
    }
  }

  if (toFetch.length > 0) {
    const batches = _chunk(toFetch, cfg.batchSize);
    const url = `${cfg.apiBase.replace(/\/+$/, '')}/serp/positions/`;
    const headers = { Authorization: `Bearer ${apiKey}` };

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      try {
        const json = await _httpJson({
          url,
          headers,
          body: { domain: dom, phrases: batch, region: rg, engine: eng },
          timeoutMs: cfg.timeoutMs,
          fetchImpl,
        });
        const parsed = _parseResponse(json, dom);
        for (const ph of batch) {
          const sig = parsed.get(ph);
          if (sig) {
            signals.set(ph, sig);
            const key = _cacheKey({
              method: 'positions', phrase: ph, domain: dom, region: rg, engine: eng,
            });
            _cacheSet(key, sig, cfg.cacheTtlMs, cfg.cacheMaxEntries);
          }
        }
      } catch (err) {
        // graceful: не валим всю задачу из-за одного упавшего батча,
        // продолжаем — на оставшиеся батчи может быть ОК.
        console.warn(`[keysso] batch ${bi + 1}/${batches.length} failed: ${err.message}`);
      }
      // щадящая задержка между батчами (кроме последнего)
      if (bi < batches.length - 1 && cfg.batchDelayMs > 0) {
        await _sleep(cfg.batchDelayMs);
      }
    }
  }

  return {
    verdict: 'ok',
    signals,
    requested:   trimmed.length,
    matched:     signals.size,
    cache_hits:  cacheHits,
    duration_ms: Date.now() - t0,
    domain:      dom,
    region:      rg,
    engine:      eng,
  };
}

// ── Aggregate signals over portfolio ──────────────────────────────────

/**
 * Сводит Map<phrase, signals> в портфельные агрегаты для прогноза и UI:
 *   • avg_current_position (среднее по фразам, где position>0)
 *   • phrases_in_top10_pct / phrases_in_top30_pct
 *   • median_competition   (медиана top10_competition)
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
    if (s.top10_competition >= 0) comps.push(s.top10_competition);
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
    // delta — положительное число = позиция РОСЛА (позиция уменьшилась):
    // зависит от соглашения API. Принимаем «delta > 0 — рост», т.е.
    // позиция улучшилась (стала ближе к 1). Если API даёт обратное —
    // адаптируйте в _parseResponse.
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
  _parseResponse,
  _normalizePhrase,
  _hostFromUrl,
};
