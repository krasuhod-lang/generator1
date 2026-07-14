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
 *   provider — 'deepseek' | 'gemini' (для calcCost и метаданных)
 *
 * hasAnalyticLLMKey() — есть ли хотя бы один API-ключ (гейт graceful-skip
 * в вызывающем коде: при отсутствии ключей пайплайн продолжает работу).
 */

const { callDeepSeek } = require('../llm/deepseek.adapter');
const { callGemini } = require('../llm/gemini.adapter');
const { calcCost } = require('../metrics/priceCalculator');

function hasAnalyticLLMKey() {
  return Boolean(process.env.DEEPSEEK_API_KEY || process.env.GEMINI_API_KEY);
}

async function callAnalyticLLM(systemPrompt, userPrompt, options = {}) {
  const hasDeepSeek = Boolean(process.env.DEEPSEEK_API_KEY);
  const hasGemini   = Boolean(process.env.GEMINI_API_KEY);

  if (!hasDeepSeek && !hasGemini) {
    throw new Error('No LLM API key configured (DEEPSEEK_API_KEY / GEMINI_API_KEY)');
  }

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

/**
 * Стоимость вызова по фактическому провайдеру. Для DeepSeek учитываем
 * prompt_cache_hit_tokens, для Gemini — cachedTokens/thoughtsTokens.
 */
function analyticCallCost(provider, resp) {
  if (provider === 'deepseek') {
    return calcCost('deepseek', resp.tokensIn || 0, resp.tokensOut || 0, {
      cacheHit: (resp.cacheHitTokens || 0) > 0,
    });
  }
  return calcCost('gemini', resp.tokensIn || 0, resp.tokensOut || 0, {
    cachedTokens: resp.cachedTokens || 0,
    thoughtsTokens: resp.thoughtsTokens || 0,
  });
}

module.exports = { callAnalyticLLM, hasAnalyticLLMKey, analyticCallCost };
