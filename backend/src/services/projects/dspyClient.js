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
  try {
    const resp = await http.post(base, `/dspy/prompt/${encodeURIComponent(signature)}`,
      { context }, { timeoutMs: cfg.timeoutMs });
    if (!resp.ok || !resp.body) return { ok: false, reason: resp.reason || 'no_response' };
    const body = resp.body;
    return {
      ok: true,
      signature,
      instructions: typeof body.instructions === 'string' ? body.instructions : '',
      demos: Array.isArray(body.demos) ? body.demos : [],
      optimized: Boolean(body.optimized),
    };
  } catch (_) {
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
