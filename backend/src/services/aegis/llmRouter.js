'use strict';

/**
 * aegis/llmRouter — маршрутизатор LLM-вызовов с фолбэком и circuit breaker.
 *
 * Цель: если primary провайдер (например, DeepSeek-V4-Pro) возвращает 429
 * (rate limit) или 502/timeout — автоматически переключиться на резервную
 * модель (Gemini, или локальная vLLM/Llama-3 70B), чтобы пайплайн не встал.
 *
 * Используется как опциональная обёртка над существующими адаптерами в
 * критичных аудит-задачах. Существующие пайплайны (info-article, и т.д.)
 * НЕ принудительно мигрируют — включается через AEGIS_ROUTING_ENABLED.
 *
 * Цепочки определяются в featureFlags.routing.{critic,writer}Chain
 * (comma-separated: deepseek,gemini,vllm).
 *
 * Кроме того, перед каждым вызовом проверяется killSwitch.isEngaged().
 */

const { getAegisFlags } = require('./featureFlags');
const { createCircuitBreaker } = require('./circuitBreaker');
const { M: metrics, recordLlmCall } = require('./telemetry');
const alerting   = require('./alerting');
const killSwitch = require('./killSwitch');
const llmUsageLog = require('./llmUsageLog');

const _breakers = new Map(); // provider → breaker

function _breaker(provider) {
  if (!_breakers.has(provider)) {
    _breakers.set(provider, createCircuitBreaker(provider));
  }
  return _breakers.get(provider);
}

function _parseChain(s) {
  return String(s || '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean);
}

// ── Lazy LLM adapters (опц., чтобы не тянуть лишние модули) ────────
function _adapter(provider) {
  if (provider === 'deepseek') {
    const a = require('../llm/deepseek.adapter');
    return async (systemMsg, userMsg, opts) => a.callDeepSeek(systemMsg, userMsg, opts);
  }
  if (provider === 'gemini') {
    const a = require('../llm/gemini.adapter');
    // gemini.adapter имеет другой signature — нормализуем.
    return async (systemMsg, userMsg, opts) => {
      if (typeof a.callGemini === 'function') {
        return a.callGemini(systemMsg, userMsg, opts);
      }
      throw new Error('gemini adapter signature unknown');
    };
  }
  if (provider === 'vllm') {
    return require('./vllmAdapter').callVllm;
  }
  throw new Error(`[aegis/llmRouter] unknown provider: ${provider}`);
}

/**
 * Извлекает статус-код / признак ошибки из исключения LLM-адаптера.
 * Поддерживает axios-style err.response.status и raw error.message парсинг.
 */
function _extractStatus(err) {
  if (!err) return null;
  if (err.response && err.response.status) return err.response.status;
  if (err.statusCode) return err.statusCode;
  const msg = String(err.message || '');
  const m = msg.match(/\b(408|429|500|502|503|504)\b/);
  return m ? parseInt(m[1], 10) : null;
}

function _isRetryable(err) {
  const cfg = getAegisFlags().routing;
  const st = _extractStatus(err);
  if (st && cfg.retryOnStatus.includes(st)) return true;
  const msg = String((err && err.message) || '').toLowerCase();
  return /\b(timeout|econnreset|enotfound|etimedout|network)\b/.test(msg);
}

/**
 * route({ kind, system, user, options? }) — главный API.
 *
 * @param {{
 *   kind?: 'critic'|'writer',                — какую цепочку использовать
 *   system: string,
 *   user:   string,
 *   options?: object,                        — пробросится в адаптер
 *   chainOverride?: string[],                — явная цепочка
 * }} args
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   provider: string|null,
 *   content?: string,
 *   usage?: object,
 *   attempts: Array<{provider:string, ok:boolean, reason?:string, status?:number}>,
 *   reason?: string,
 * }>}
 */
async function route({ kind = 'critic', system, user, options = {}, chainOverride = null } = {}) {
  // 1. Kill switch.
  if (killSwitch.isEngaged()) {
    return {
      ok: false, provider: null, attempts: [],
      reason: 'killswitch', killswitch: killSwitch.snapshot(),
    };
  }

  // 2. Если routing выключен — fall back на DeepSeek (как было).
  const cfg = getAegisFlags().routing;
  if (!cfg.enabled && !chainOverride) {
    // Прозрачный путь: просто DeepSeek.
    return _callOnce('deepseek', system, user, options, kind);
  }

  const chain = chainOverride
    || (kind === 'writer' ? _parseChain(cfg.writerChain) : _parseChain(cfg.criticChain));
  if (!chain.length) {
    return { ok: false, provider: null, attempts: [], reason: 'empty_chain' };
  }

  const attempts = [];
  for (const provider of chain) {
    const cb = _breaker(provider);
    if (!cb.canPass()) {
      attempts.push({ provider, ok: false, reason: 'circuit_open' });
      continue;
    }
    const r = await _callOnce(provider, system, user, options, kind);
    attempts.push({ provider, ok: r.ok, reason: r.reason, status: r.status });
    if (r.ok) {
      cb.recordSuccess();
      return { ...r, attempts };
    }
    cb.recordFailure();
    // Если это НЕ retryable — всё равно пробуем следующего, чтобы максимально
    // не уронить пайплайн, но не открываем circuit зря.
  }

  // Всё провалилось — alert.
  await alerting.sendAlert({
    severity: 'critical',
    message:  `[aegis/llmRouter] All providers in chain failed: ${chain.join(',')}`,
    payload:  { kind, attempts },
  });
  return { ok: false, provider: null, attempts, reason: 'all_failed' };
}

async function _callOnce(provider, system, user, options, kind = null) {
  const t0 = Date.now();
  try {
    const adapter = _adapter(provider);
    const resp = await adapter(system, user, options);
    const latencyMs = Date.now() - t0;
    const usage = (resp && resp.usage) || {};
    const tokensIn      = usage.tokensIn  || usage.tokens_in  || 0;
    const tokensOut     = usage.tokensOut || usage.tokens_out || 0;
    const costUsd       = usage.cost_usd  || usage.costUsd    || 0;
    const cacheHitTokens = usage.cachedTokens || usage.cacheHitTokens || 0;
    recordLlmCall({
      provider,
      tokensIn,
      tokensOut,
      costUsd,
      cacheHitTokens,
      latencyMs,
      outcome:        'ok',
    });
    // Персист посуточного расхода Эгиды (best-effort, не блокирует ответ).
    llmUsageLog.recordUsage({
      provider,
      kind,
      tokensIn,
      tokensOut,
      cachedTokens: cacheHitTokens,
      costUsd,
      cacheHit:     cacheHitTokens > 0,
      latencyMs,
      outcome:      'ok',
    }).catch(() => {});
    alerting.recordSpend({ provider, costUsd: usage.cost_usd || usage.costUsd || 0 });
    return {
      ok:       true,
      provider,
      content:  (resp && (resp.content || resp.text || resp.html)) || '',
      usage,
      latencyMs,
    };
  } catch (err) {
    const latencyMs = Date.now() - t0;
    const status = _extractStatus(err);
    metrics.requests.inc(1, { provider, outcome: 'error' });
    llmUsageLog.recordUsage({ provider, kind, outcome: 'error', latencyMs }).catch(() => {});
    return {
      ok:       false,
      provider,
      reason:   String(err.message || 'unknown_error').slice(0, 200),
      status,
      retryable: _isRetryable(err),
      latencyMs,
    };
  }
}

function getBreakerStates() {
  const out = {};
  for (const [p, cb] of _breakers) out[p] = cb.snapshot();
  return out;
}

function _resetForTests() {
  for (const cb of _breakers.values()) cb._reset();
}

module.exports = {
  route,
  getBreakerStates,
  _parseChain,
  _extractStatus,
  _isRetryable,
  _resetForTests,
};
