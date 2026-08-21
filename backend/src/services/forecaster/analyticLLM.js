'use strict';

/**
 * forecaster/analyticLLM.js — единая точка обращения к LLM для всей
 * аналитики прогнозатора (deepseekAnalyzer.js, forecastReport.js).
 *
 * Политика роутинга моделей проекта: все аналитические вызовы идут через
 * DeepSeek (модель из env DEEPSEEK_MODEL, по умолчанию deepseek-v4-pro),
 * Gemini остаётся фолбэком, если DeepSeek недоступен или вызов упал.
 *
 * callAnalyticLLM(system, user, options) → { resp, provider }
 *   resp     — унифицированный ответ адаптера ({ text, tokensIn, tokensOut, model, … })
 *              + resp.truncated=true, если лимит вывода так и не помог
 *   provider — 'deepseek' | 'gemini' (для calcCost и метаданных)
 *
 * Защита от обрезки: reasoning-модели (deepseek-v4-pro, gemini-3.x) тратят
 * часть max_tokens на рассуждения, поэтому при маленьком лимите приходит
 * пустой или недописанный JSON (finish_reason='length' / 'MAX_TOKENS').
 * В этом случае повторяем вызов с удвоенным лимитом (до TRUNCATION_RETRIES
 * раз, потолок MAX_OUTPUT_TOKENS_CAP как в адаптерах) — по аналогии с
 * callLLM.js. Если и это не помогло, возвращаем ответ как есть с флагом
 * truncated, чтобы вызывающая сторона показала внятную причину.
 *
 * hasAnalyticLLMKey() — есть ли хотя бы один API-ключ (гейт graceful-skip
 * в вызывающем коде: при отсутствии ключей пайплайн продолжает работу).
 */

const { callDeepSeek, DEEPSEEK_DEFAULT_MAX_TOKENS } = require('../llm/deepseek.adapter');
const { callGemini } = require('../llm/gemini.adapter');
const { calculateCostBreakdown } = require('../metrics/priceCalculator');

// Верхняя граница maxTokens в обоих адаптерах (валидация бросает выше неё).
const MAX_OUTPUT_TOKENS_CAP = 32000;
// Сколько РАЗ дополнительно повторяем вызов с удвоенным лимитом.
const TRUNCATION_RETRIES = 2;
// finish_reason, означающий обрезку по лимиту вывода: 'length' — DeepSeek/
// OpenAI-совместимые, 'MAX_TOKENS' — Gemini.
const TRUNCATED_FINISH_REASONS = new Set(['length', 'MAX_TOKENS']);

function hasAnalyticLLMKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY || process.env.GEMINI_API_KEY);
}

/**
 * Ответ обрезан лимитом вывода (или пуст — reasoning съел весь бюджет)?
 * @param {{text?:string, finishReason?:string}} resp
 */
function isTruncatedResponse(resp) {
  if (!resp) return true;
  if (TRUNCATED_FINISH_REASONS.has(String(resp.finishReason || ''))) return true;
  return !String(resp.text || '').trim();
}

async function _callOnce(systemPrompt, userPrompt, options) {
  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasGemini   = Boolean(process.env.GEMINI_API_KEY);

  if (hasDeepSeek) {
    try {
      const resp = await callDeepSeek(systemPrompt, userPrompt, options);
      return { resp, provider: 'deepseek' };
    } catch (err) {
      if (!hasGemini) throw err;
      console.warn('[forecaster/analyticLLM] DeepSeek failed, falling back to Gemini:', err.message);
    }
  }

  const resp = await callGemini(systemPrompt, userPrompt, options);
  return { resp, provider: 'gemini' };
}

async function callAnalyticLLM(systemPrompt, userPrompt, options = {}) {
  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasGemini   = Boolean(process.env.GEMINI_API_KEY);

  if (!hasDeepSeek && !hasGemini) {
    throw new Error('No LLM API key configured (DEEPSEEK_API_KEY / GEMINI_API_KEY)');
  }

  // Если лимит не задан явно — базой считаем дефолт адаптера, иначе удвоение
  // ПОНИЖАЛО бы фактический лимит запроса (см. callLLM.js).
  const requested = Number(options.maxTokens);
  let maxTokens = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : DEEPSEEK_DEFAULT_MAX_TOKENS,
    MAX_OUTPUT_TOKENS_CAP,
  );

  let out = null;
  for (let attempt = 0; attempt <= TRUNCATION_RETRIES; attempt++) {
    out = await _callOnce(systemPrompt, userPrompt, { ...options, maxTokens });
    if (!isTruncatedResponse(out.resp)) return out;
    if (attempt === TRUNCATION_RETRIES || maxTokens >= MAX_OUTPUT_TOKENS_CAP) break;
    const newMax = Math.min(maxTokens * 2, MAX_OUTPUT_TOKENS_CAP);
    console.warn(
      `[forecaster/analyticLLM] truncated response (provider=${out.provider}, `
      + `finishReason=${out.resp?.finishReason || 'empty'}, maxTokens=${maxTokens}) — `
      + `retry ${attempt + 1}/${TRUNCATION_RETRIES} with maxTokens=${newMax}`,
    );
    maxTokens = newMax;
  }

  if (out && out.resp) out.resp.truncated = true;
  return out;
}

/**
 * Стоимость вызова по фактическому провайдеру. Для DeepSeek учитываем
 * prompt_cache_hit_tokens, для Gemini — cachedTokens/thoughtsTokens.
 */
function analyticCallCost(provider, resp) {
  if (provider === 'deepseek') {
    const pricing = calculateCostBreakdown(resp.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro', resp.tokensIn || 0, resp.tokensOut || 0, {
      cacheHitTokens: resp.cacheHitTokens || 0,
      cacheMissTokens: resp.cacheMissTokens,
    });
    return pricing.totalUsd;
  }
  return calculateCostBreakdown('gemini', resp.tokensIn || 0, resp.tokensOut || 0, {
    cachedTokens: resp.cachedTokens || 0,
    thoughtsTokens: resp.thoughtsTokens || 0,
  }).totalUsd;
}

module.exports = {
  callAnalyticLLM,
  hasAnalyticLLMKey,
  analyticCallCost,
  isTruncatedResponse,
  MAX_OUTPUT_TOKENS_CAP,
  TRUNCATION_RETRIES,
};
