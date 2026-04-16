'use strict';

/**
 * Тарифы LLM-провайдеров (апрель 2026).
 * Источник: раздел 10 ТЗ.
 */
const PRICES = {
  deepseek: {
    input_cache_miss: 0.000000270,  // $0.27 / 1M tokens
    input_cache_hit:  0.000000070,  // $0.07 / 1M tokens
    output:           0.000001100,  // $1.10 / 1M tokens
  },
  gemini: {
    input:  0.000001250,  // $1.25 / 1M tokens (≤200K context)
    output: 0.000005000,  // $5.00 / 1M tokens
  },
};

/**
 * Рассчитывает стоимость вызова LLM в USD.
 *
 * @param {'deepseek'|'gemini'} model
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @param {boolean} [cacheHit=false]  — для DeepSeek: был ли кэш-хит
 * @returns {number} — стоимость в USD
 */
function calcCost(model, tokensIn, tokensOut, cacheHit = false) {
  if (model === 'deepseek') {
    const inputRate = cacheHit
      ? PRICES.deepseek.input_cache_hit
      : PRICES.deepseek.input_cache_miss;
    return tokensIn * inputRate + tokensOut * PRICES.deepseek.output;
  }

  if (model === 'gemini') {
    return tokensIn * PRICES.gemini.input + tokensOut * PRICES.gemini.output;
  }

  return 0;
}

/**
 * Форматирует стоимость для отображения (напр. "$0.0142").
 */
function formatCost(usd) {
  return `$${usd.toFixed(4)}`;
}

module.exports = { calcCost, formatCost, PRICES };
