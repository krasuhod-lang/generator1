'use strict';

/**
 * serpEvidence.service — Phase 1 / P0-2 SERP-evidence grounding.
 *
 * Назначение: для запроса (темы статьи) собрать «фактологическую базу» из
 * top-N URL Яндекса в виде top-K BM25-абзацев на каждый URL. База идёт в
 * writer-промт инфо-статьи (см. infoArticlePipeline.runWriter), чтобы
 * Gemini опирался на реальный текст конкурентов, а не на параметрику
 * модели. Это фундамент для последующих P0-1 (fact-check) и P0-3
 * (антиплагиат), которые потребляют тот же evidence.
 *
 * Поток:
 *   1. fetchYandexSerp(query, lr, pages=1) — берём верх SERP.
 *   2. fetchPages(urls) — параллельный download HTML.
 *   3. POST /evidence в Python-микросервис → top-K параграфов на URL.
 *   4. Кэшируем результат in-memory (LRU + TTL) по ключу
 *      hash(query|lr|topN|topK|maxChars). Redis-кэш — отдельным PR;
 *      in-memory достаточно для V1 (writer-этап один на задачу).
 *
 * Контракт ответа:
 *   {
 *     query, region,
 *     fetched_at,           // ISO timestamp
 *     evidence: [
 *       { url, h1, snippets:[{text, score, position}], text_chars,
 *         parsed_method, empty_reason, published_at }, ...
 *     ],
 *     stats: { fetched_count, failed_count, snippet_count, duration_ms,
 *              cache_hit:boolean, source: 'serp'|'cache' },
 *     warnings: [string, ...],   // non-fatal: «5/10 страниц упали по 403»
 *   }
 *
 * Все ошибки graceful: если SERP пуст / fetch упал на всех URL / Python
 * вернул 500 — возвращаем `{ evidence: [], warnings:[…], stats: {…} }`.
 * Грузовое место в pipeline само решит, прерывать ли writer (по гейту
 * INFO_ARTICLE_GROUNDING_REQUIRED). По умолчанию gracefully игнорируется.
 */

const crypto = require('crypto');

const { fetchYandexSerp } = require('../metaTags/xmlstockClient');
const { fetchPages }      = require('../relevance/pageFetcher');
const { evidence: callEvidenceService } = require('../relevance/pythonClient');

// ── Config (env-overridable) ─────────────────────────────────────────

const TOP_N = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_GROUNDING_TOP_N, 10);
  return Number.isFinite(v) && v >= 1 && v <= 20 ? v : 5;
})();

const TOP_K = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_GROUNDING_TOP_K, 10);
  return Number.isFinite(v) && v >= 1 && v <= 20 ? v : 5;
})();

const MAX_CHARS_PER_URL = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_GROUNDING_MAX_CHARS_PER_URL, 10);
  return Number.isFinite(v) && v >= 200 && v <= 20000 ? v : 1500;
})();

const CACHE_TTL_MS = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_GROUNDING_CACHE_TTL_S, 10);
  // Дефолт — 1 час. Темы статей повторяются редко; долго хранить смысла нет,
  // а свежесть SERP — фактор качества (события месяца, новые товары).
  return Number.isFinite(v) && v >= 60 && v <= 86400 ? v * 1000 : 60 * 60 * 1000;
})();

const CACHE_MAX_ENTRIES = (() => {
  const v = parseInt(process.env.INFO_ARTICLE_GROUNDING_CACHE_MAX, 10);
  return Number.isFinite(v) && v >= 2 && v <= 1000 ? v : 64;
})();

// ── In-memory LRU + TTL cache ─────────────────────────────────────────
//
// Map сохраняет порядок вставки → дешёвый LRU. При hit удаляем и
// вставляем снова, чтобы переместить в «голову» (хвост Map = most-recent).
// При превышении CACHE_MAX_ENTRIES срезаем самый старый (первый в Map).

const _cache = new Map();   // key → { value, expiresAt }

function _cacheKey({ query, region, topN, topK, maxChars }) {
  const norm = JSON.stringify({
    q: String(query || '').trim().toLowerCase(),
    r: String(region || '').trim().toLowerCase(),
    n: topN,
    k: topK,
    c: maxChars,
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
  // Move-to-head (LRU): re-insert.
  _cache.delete(key);
  _cache.set(key, hit);
  return hit.value;
}

function _cacheSet(key, value) {
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    // Удаляем «самый старый» (первый ключ в порядке вставки).
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function _cacheClear() {
  _cache.clear();
}

function _cacheStats() {
  let alive = 0;
  const now = Date.now();
  for (const v of _cache.values()) if (v.expiresAt > now) alive += 1;
  return { size: _cache.size, alive, ttlMs: CACHE_TTL_MS, max: CACHE_MAX_ENTRIES };
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * @param {{ query:string, region?:string, topN?:number, topK?:number,
 *           maxCharsPerUrl?:number, force?:boolean,
 *           logger?: (msg:string, level?:string) => void }} opts
 * @returns {Promise<{ query, region, fetched_at, evidence, stats, warnings }>}
 */
async function buildSerpEvidence(opts = {}) {
  const t0 = Date.now();
  const query  = String(opts.query || '').trim();
  const region = String(opts.region || '').trim();
  const topN   = _clampInt(opts.topN, TOP_N, 1, 20);
  const topK   = _clampInt(opts.topK, TOP_K, 1, 20);
  const maxChars = _clampInt(opts.maxCharsPerUrl, MAX_CHARS_PER_URL, 200, 20000);
  const log    = typeof opts.logger === 'function' ? opts.logger : () => {};

  if (!query) {
    return _emptyResult({
      query, region,
      durationMs: Date.now() - t0,
      warnings: ['empty_query'],
    });
  }

  const key = _cacheKey({ query, region, topN, topK, maxChars });
  if (!opts.force) {
    const cached = _cacheGet(key);
    if (cached) {
      log(`📚 SERP-evidence: cache hit (key=${key.slice(0, 8)}…)`, 'info');
      return {
        ...cached,
        stats: { ...cached.stats, cache_hit: true, source: 'cache', duration_ms: Date.now() - t0 },
      };
    }
  }

  const warnings = [];

  // 1. SERP
  let serpRaw;
  try {
    serpRaw = await fetchYandexSerp(query, { lr: region || '', pages: 1 });
  } catch (e) {
    return _emptyResult({
      query, region,
      durationMs: Date.now() - t0,
      warnings: [`serp_failed: ${(e && e.message ? e.message : 'unknown').slice(0, 200)}`],
    });
  }

  // Дедуп по URL и хосту, обрезка до topN — те же правила, что в
  // relevance/pipeline.js (см. _canonicalHost), чтобы получать тот же
  // top, который видит пользователь в отчётах релевантности.
  const seenUrl = new Set();
  const seenHost = new Set();
  const serp = [];
  for (const item of (serpRaw || [])) {
    const url = String(item && item.url || '').trim();
    if (!url || seenUrl.has(url)) continue;
    seenUrl.add(url);
    const host = _canonicalHost(url);
    if (host && seenHost.has(host)) continue;
    if (host) seenHost.add(host);
    serp.push({ url, position: serp.length + 1 });
    if (serp.length >= topN) break;
  }

  if (serp.length === 0) {
    return _emptyResult({
      query, region,
      durationMs: Date.now() - t0,
      warnings: ['serp_empty'],
    });
  }

  // 2. Fetch HTML
  const { successes, failures } = await fetchPages(serp.map((s) => s.url));
  if (failures.length) {
    warnings.push(`fetch_failed: ${failures.length}/${serp.length}`);
    log(`⚠ SERP-evidence: ${failures.length}/${serp.length} URL не скачались`, 'warn');
  }
  if (successes.length === 0) {
    return _emptyResult({
      query, region,
      durationMs: Date.now() - t0,
      warnings: warnings.concat(['fetch_all_failed']),
    });
  }

  // 3. Python /evidence
  let resp;
  try {
    resp = await callEvidenceService({
      query,
      documents: successes.map((s) => ({ url: s.url, html: s.html })),
      options: {
        top_k_paragraphs: topK,
        max_chars_per_url: maxChars,
      },
    });
  } catch (e) {
    return _emptyResult({
      query, region,
      durationMs: Date.now() - t0,
      warnings: warnings.concat([`evidence_service_failed: ${(e && e.message ? e.message : 'unknown').slice(0, 200)}`]),
    });
  }

  const items = Array.isArray(resp && resp.evidence) ? resp.evidence : [];
  // Подмешаем serp-position в результат — writer-промт будет видеть, какие
  // источники реально топ-1/2/3, а какие — топ-5/8.
  const positionByUrl = new Map(serp.map((s) => [s.url, s.position]));
  const enriched = items.map((it) => ({
    ...it,
    serp_position: positionByUrl.get(it.url) || null,
  }));

  const snippetCount = enriched.reduce((acc, it) => acc + (Array.isArray(it.snippets) ? it.snippets.length : 0), 0);

  const result = {
    query,
    region,
    fetched_at: new Date().toISOString(),
    evidence: enriched,
    stats: {
      fetched_count: successes.length,
      failed_count:  failures.length,
      snippet_count: snippetCount,
      duration_ms:   Date.now() - t0,
      cache_hit:     false,
      source:        'serp',
      top_n:         topN,
      top_k:         topK,
      max_chars_per_url: maxChars,
    },
    warnings,
  };

  _cacheSet(key, result);
  log(`📚 SERP-evidence: ${enriched.length} URL × до ${topK} сниппетов (${snippetCount} всего, ${result.stats.duration_ms} мс)`, 'ok');
  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────

function _emptyResult({ query, region, durationMs, warnings }) {
  return {
    query,
    region,
    fetched_at: new Date().toISOString(),
    evidence: [],
    stats: {
      fetched_count: 0,
      failed_count: 0,
      snippet_count: 0,
      duration_ms: durationMs,
      cache_hit: false,
      source: 'serp',
    },
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

function _clampInt(v, def, lo, hi) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function _canonicalHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

// ── Render to writer-prompt block ─────────────────────────────────────

/**
 * Рендерит SERP-evidence в компактный текстовый блок для user-промта
 * Stage 3 writer'а. Формат подобран так, чтобы:
 *   • читаемо для LLM (нумерация, явный URL, снизу — сниппет в кавычках);
 *   • легко цитировалось в self_audit (writer может ответить «опираюсь на
 *     evidence #2»);
 *   • не съедало много токенов (без JSON-обёрток).
 *
 * Возвращает '' если evidence пуст — вызывающий код просто не вставляет блок.
 */
function renderEvidenceForPrompt(evidenceResult, { maxUrls = 8, maxSnippetChars = 600 } = {}) {
  if (!evidenceResult || !Array.isArray(evidenceResult.evidence) || evidenceResult.evidence.length === 0) {
    return '';
  }
  const lines = [];
  lines.push('[SERP_EVIDENCE — реальные фрагменты из top SERP по теме статьи]');
  lines.push('Используй эти фрагменты как ОПОРУ для фактов, цифр, списков и формулировок.');
  lines.push('Не выдумывай статистику и кейсы — если данных нет в evidence, обходись общим описанием.');
  lines.push('');

  const items = evidenceResult.evidence.slice(0, maxUrls);
  let n = 0;
  for (const it of items) {
    const snippets = Array.isArray(it.snippets) ? it.snippets : [];
    if (snippets.length === 0) continue;
    n += 1;
    const pos = it.serp_position ? `#${it.serp_position}` : '#?';
    const h1 = (it.h1 || '').slice(0, 160);
    lines.push(`(${n}) [${pos}] ${it.url}${h1 ? `  — ${h1}` : ''}`);
    snippets.forEach((s, i) => {
      const text = String(s && s.text || '').slice(0, maxSnippetChars).replace(/\s+/g, ' ').trim();
      if (text) lines.push(`    ${String.fromCharCode(0x2022)} ${text}`);
      void i;
    });
    lines.push('');
  }
  if (n === 0) return '';
  return lines.join('\n').trimEnd();
}

module.exports = {
  buildSerpEvidence,
  renderEvidenceForPrompt,
  // exposed for tests / diagnostics
  _cacheClear,
  _cacheStats,
  _cacheKey,
  TOP_N,
  TOP_K,
  MAX_CHARS_PER_URL,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
};
