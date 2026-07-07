'use strict';

/**
 * projects/dspyClient.js — node-обёртка над DSPy-усилением промптов в aegis_py
 * (п.6 ТЗ: «Настоятельно требую использовать DSPY для усиления промтов»).
 *
 * Идея: детерминированные слои анализа GSC (linkRecommender, topicGenerator,
 * eatRecommender, aeoOptimizer, schemaRecommender, pageMetaAudit) перед вызовом
 * DeepSeek/Gemini могут запросить у aegis_py few-shot-усиленные инструкции по
 * именованной DSPy-сигнатуре. aegis_py возвращает оптимизированный prompt-
 * суффикс (демонстрации + уточнённые инструкции), который мы подмешиваем в
 * system/user prompt.
 *
 * ПОЛНОСТЬЮ GRACEFUL: если aegis_py не сконфигурирован (AEGIS_PY_URL пустой),
 * недоступен, выключен флагом или вернул ошибку — отдаём { ok:false } и
 * вызывающий код работает по статическому промпту (DSPy опционален).
 */

const http = require('../aegis/_httpClient');
const { getProjectsConfig } = require('./config');

function _baseUrl() {
  // Тот же источник, что и остальной aegis-стек (featureFlags.pyServiceUrl).
  return (process.env.AEGIS_PY_URL || '').trim();
}

// ── Бесперебойность DSPy (E-E-A-T-требование) ─────────────────────────
// 1. Ретраи с backoff на transient-сбоях (network/timeout/5xx) — одиночный
//    сетевой глюк больше не оставляет промпт без усиления.
// 2. Circuit breaker: после N подряд неудач перестаём дёргать aegis_py на
//    cooldown-период, чтобы каждый вызов пайплайна не ждал таймаут впустую.
const DSPY_MAX_ATTEMPTS = Math.max(1, parseInt(process.env.DSPY_MAX_ATTEMPTS || '2', 10) || 2);
const DSPY_RETRY_BASE_MS = 500;
const DSPY_CB_FAILURE_THRESHOLD = Math.max(1, parseInt(process.env.DSPY_CB_FAILURE_THRESHOLD || '3', 10) || 3);
const DSPY_CB_COOLDOWN_MS = Math.max(5000, parseInt(process.env.DSPY_CB_COOLDOWN_MS || '60000', 10) || 60000);

const _circuit = { consecutiveFailures: 0, openedUntil: 0 };

function _circuitOpen() {
  return _circuit.openedUntil > Date.now();
}

function _recordFailure() {
  _circuit.consecutiveFailures += 1;
  if (_circuit.consecutiveFailures >= DSPY_CB_FAILURE_THRESHOLD) {
    _circuit.openedUntil = Date.now() + DSPY_CB_COOLDOWN_MS;
    _circuit.consecutiveFailures = 0;
    console.warn(`[dspyClient] circuit opened for ${DSPY_CB_COOLDOWN_MS}ms after repeated failures`);
  }
}

function _recordSuccess() {
  _circuit.consecutiveFailures = 0;
  _circuit.openedUntil = 0;
}

function _isTransient(resp) {
  if (!resp) return true;
  if (resp.reason === 'network') return true;
  if (resp.reason === 'http_status' && Number(resp.status) >= 500) return true;
  return false;
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Запрашивает у aegis_py усиленные инструкции по DSPy-сигнатуре.
 *
 * @param {string} signature — одно из cfg.dspy.signatures (LinkRecommend, ...)
 * @param {object} context   — произвольный JSON-контекст (фичи среза, ниша…)
 * @returns {Promise<{ok:boolean, instructions?:string, demos?:Array, reason?:string}>}
 */
async function enhancePrompt(signature, context = {}) {
  const cfg = getProjectsConfig().dspy;
  if (!cfg.enabled) return { ok: false, reason: 'feature_disabled' };
  if (!cfg.signatures.includes(signature)) return { ok: false, reason: 'unknown_signature' };
  const base = _baseUrl();
  if (!base) return { ok: false, reason: 'not_configured' };
  if (_circuitOpen()) return { ok: false, reason: 'circuit_open' };
  try {
    let resp = null;
    for (let attempt = 1; attempt <= DSPY_MAX_ATTEMPTS; attempt++) {
      resp = await http.post(base, `/dspy/prompt/${encodeURIComponent(signature)}`,
        { context }, { timeoutMs: cfg.timeoutMs });
      if (resp.ok || !_isTransient(resp)) break;
      if (attempt < DSPY_MAX_ATTEMPTS) await _sleep(DSPY_RETRY_BASE_MS * attempt);
    }
    if (!resp || !resp.ok || !resp.body) {
      _recordFailure();
      return { ok: false, reason: (resp && resp.reason) || 'no_response' };
    }
    _recordSuccess();
    const body = resp.body;
    return {
      ok: true,
      signature,
      instructions: typeof body.instructions === 'string' ? body.instructions : '',
      demos: Array.isArray(body.demos) ? body.demos : [],
      optimized: Boolean(body.optimized),
    };
  } catch (_) {
    _recordFailure();
    return { ok: false, reason: 'error' };
  }
}

/**
 * Удобный хелпер: вернуть готовый текстовый блок для подмешивания в промпт.
 * При недоступности DSPy — пустая строка (промпт остаётся статическим).
 *
 * @returns {Promise<string>}
 */
async function buildPromptSuffix(signature, context = {}) {
  const r = await enhancePrompt(signature, context);
  if (!r.ok || !r.instructions) return '';
  const lines = ['', `[DSPY-УСИЛЕНИЕ: ${signature}]`, r.instructions];
  if (r.demos && r.demos.length) {
    lines.push('Примеры удачных формулировок (few-shot):');
    r.demos.slice(0, 3).forEach((d, i) => {
      lines.push(`${i + 1}. ${typeof d === 'string' ? d : JSON.stringify(d)}`);
    });
  }
  return lines.join('\n');
}

module.exports = { enhancePrompt, buildPromptSuffix };
