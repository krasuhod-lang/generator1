'use strict';

/**
 * aegis/vectordbClient — клиент к Qdrant (hybrid: dense + sparse BM25)
 * через aegis_py. Графейс-деградирует.
 *
 * Применение:
 *   - index({ niche, paragraphs }) — индексируем абзацы с сайтов-доноров
 *     после Stage 0 (рецепторы).
 *   - search({ niche, query, topK }) — мгновенный фактчекинг (числа,
 *     имена) и антиплагиат через RRF dense+sparse rerank.
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

function _opts() {
  const cfg = getAegisFlags().vectordb;
  return {
    base: getAegisFlags().graphrag.pyServiceUrl, // тот же FastAPI
    timeoutMs: cfg.requestTimeoutMs,
    enabled:   cfg.enabled,
    embedder:  cfg.embedder,
    alpha:     cfg.hybridAlpha,
  };
}

async function index({ niche, paragraphs = [], sourceUrl = null } = {}) {
  const { base, timeoutMs, enabled, embedder } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled' };
  return http.post(base, '/vectordb/index', { niche, paragraphs, source_url: sourceUrl, embedder }, { timeoutMs });
}

/**
 * search({ niche, query, topK }) — гибридный поиск ближайших абзацев.
 *
 * @returns {Promise<{ok:boolean, hits:Array<{text,score,source_url,niche}>}>}
 */
async function search({ niche, query, topK = 5 } = {}) {
  const { base, timeoutMs, enabled, embedder, alpha } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled', hits: [] };
  const r = await http.post(base, '/vectordb/search', {
    niche, query, top_k: topK, embedder, hybrid_alpha: alpha,
  }, { timeoutMs });
  if (!r.ok) return { ok: false, reason: r.reason, hits: [] };
  return { ok: true, hits: (r.body && r.body.hits) || [] };
}

async function health() {
  const { base, timeoutMs } = _opts();
  const r = await http.get(base, '/vectordb/health', { timeoutMs });
  return { ok: r.ok, status: r.status, body: r.body, reason: r.reason };
}

module.exports = { index, search, health };
