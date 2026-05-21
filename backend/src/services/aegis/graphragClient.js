'use strict';

/**
 * aegis/graphragClient — клиент к подсистеме GraphRAG (Neo4j) в
 * микросервисе aegis_py. Графейс-деградирует.
 *
 * Стороны графа:
 *   - Entity(name, niche, weight)
 *   - Intent(label, niche)
 *   - CompetitorFact(hash, text, source_url, numeric)
 *   - Article(id, niche, spq, published_at)
 *   - Связи: COVERS_INTENT, PROVES_FACT, RELATES_TO.
 *
 * Этап 1-2 пайплайна (Graph Builder): upsert.
 * Этап 3 (Writer-контекст): retrieveTopLsi через NetworkX betweenness.
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

function _opts() {
  const cfg = getAegisFlags().graphrag;
  return {
    base: cfg.pyServiceUrl,
    timeoutMs: cfg.requestTimeoutMs,
    enabled: cfg.enabled,
    topK: cfg.centralityTopK,
  };
}

/**
 * upsertGraph({ niche, entities, intents, facts, articleId }) — пишет
 * узлы и связи в Neo4j через aegis_py.
 *
 * Безопасно вызывать даже при выключенном Graphrag — вернёт { ok:false,
 * reason:'disabled' } и не зашумит логи.
 */
async function upsertGraph({ niche, entities = [], intents = [], facts = [], articleId = null } = {}) {
  const { base, timeoutMs, enabled } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled' };
  return http.post(base, '/graphrag/upsert', { niche, entities, intents, facts, articleId }, { timeoutMs });
}

/**
 * retrieveTopLsi({ niche, query, topK? }) — возвращает top-K самых
 * «авторитетных» Entity/Intent узлов по Betweenness Centrality.
 * Используется писателем (Gemini) как чистый LSI-контекст вместо
 * шумных плоских JSON.
 *
 * @returns {Promise<{ ok:boolean, items:Array, reason?:string }>}
 */
async function retrieveTopLsi({ niche, query = '', topK = null } = {}) {
  const { base, timeoutMs, enabled, topK: dfltK } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled', items: [] };
  const k = Number.isFinite(topK) ? topK : dfltK;
  const r = await http.post(base, '/graphrag/retrieve_lsi', { niche, query, top_k: k }, { timeoutMs });
  if (!r.ok) return { ok: false, reason: r.reason, items: [] };
  return { ok: true, items: (r.body && r.body.items) || [] };
}

/**
 * health() — проверка доступности GraphRAG-подсистемы.
 */
async function health() {
  const { base, timeoutMs } = _opts();
  const r = await http.get(base, '/graphrag/health', { timeoutMs });
  return { ok: r.ok, status: r.status, body: r.body, reason: r.reason };
}

module.exports = { upsertGraph, retrieveTopLsi, health };
