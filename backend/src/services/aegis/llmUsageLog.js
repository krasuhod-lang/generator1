'use strict';

/**
 * aegis/llmUsageLog — best-effort персист расхода каждого AEGIS LLM-вызова.
 *
 * Зачем: чтобы в admin-разделе «Расходы Эгиды по дням» точно видеть, сколько
 * лимитов Эгида расходует регулярно (токены in/out, стоимость USD) и кушает
 * ли она prompt-кэш (cached_tokens / cache_hit). Источник данных —
 * aegis/llmRouter, единственный chokepoint LLM-вызовов мозга.
 *
 * Пишет ОДНУ строку в aegis_llm_usage на вызов. Никогда не бросает — сбой
 * записи аналитики не должен валить пайплайн (как aegis/funnelTracker.persist).
 * Гейтится флагом featureFlags.costLog.enabled (по умолчанию true, без ENV).
 */

const { getAegisFlags } = require('./featureFlags');

// db опционален (в unit-тестах модуль грузится без БД).
let _db = null;
function _getDb() {
  if (_db === null) {
    try { _db = require('../../config/db'); }
    catch (_e) { _db = false; }
  }
  return _db || null;
}

function _enabled() {
  try { return getAegisFlags().costLog.enabled === true; }
  catch (_e) { return false; }
}

function _int(v) {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * recordUsage({ provider, model, kind, tokensIn, tokensOut, cachedTokens,
 *               cacheHitTokens, cacheMissTokens, thoughtsTokens, inputCostUsd,
 *               outputCostUsd, pricingMode, costUsd, cacheHit, latencyMs,
 *               outcome }) — async, никогда не бросает.
 */
async function recordUsage(meta = {}) {
  if (!_enabled()) return { ok: false, reason: 'disabled' };
  const db = _getDb();
  if (!db) return { ok: false, reason: 'no_db' };

  try {
    const cached = _int(meta.cachedTokens != null ? meta.cachedTokens : meta.cacheHitTokens);
    const cacheHitTokens = _int(meta.cacheHitTokens != null ? meta.cacheHitTokens : cached);
    const cacheMissTokens = _int(meta.cacheMissTokens != null
      ? meta.cacheMissTokens
      : Math.max(0, _int(meta.tokensIn) - cacheHitTokens));
    const thoughtsTokens = _int(meta.thoughtsTokens);
    const cost = Number.isFinite(Number(meta.costUsd)) && Number(meta.costUsd) > 0
      ? Number(meta.costUsd) : 0;
    const inputCost = Number.isFinite(Number(meta.inputCostUsd))
      ? Number(meta.inputCostUsd) : 0;
    const outputCost = Number.isFinite(Number(meta.outputCostUsd))
      ? Number(meta.outputCostUsd) : 0;
    await db.query(
      `INSERT INTO aegis_llm_usage
         (provider, model, kind, outcome, tokens_in, tokens_out, cached_tokens,
          cache_hit_tokens, cache_miss_tokens, thoughts_tokens,
          input_cost_usd, output_cost_usd, cost_usd, pricing_mode,
          cache_hit, latency_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
      [
        String(meta.provider || 'unknown').toLowerCase().slice(0, 32),
        meta.model ? String(meta.model).slice(0, 100) : null,
        meta.kind ? String(meta.kind).slice(0, 32) : null,
        String(meta.outcome || 'ok').slice(0, 16),
        _int(meta.tokensIn),
        _int(meta.tokensOut),
        cached,
        cacheHitTokens,
        cacheMissTokens,
        thoughtsTokens,
        inputCost,
        outputCost,
        cost,
        meta.pricingMode ? String(meta.pricingMode).slice(0, 16) : null,
        meta.cacheHit != null ? Boolean(meta.cacheHit) : cacheHitTokens > 0,
        meta.latencyMs != null && Number.isFinite(Number(meta.latencyMs))
          ? Math.trunc(Number(meta.latencyMs)) : null,
      ],
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'db_error', error: e.message };
  }
}

module.exports = { recordUsage };
