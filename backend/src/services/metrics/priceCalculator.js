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
    // Тиражированная модель: до 200K токенов контекста
    input_short:  0.000002000,  // $2.00 / 1M tokens (≤200K context)
    // От 200K токенов контекста
    input_long:   0.000004000,  // $4.00 / 1M tokens (>200K context)
    output:       0.000012000,  // $12.00 / 1M tokens
  },
};

/** Порог контекста Gemini: до 200 000 токенов — короткий тариф */
const GEMINI_SHORT_CONTEXT_LIMIT = 200_000;

/**
 * Оценивает количество токенов в тексте на основе правил токенизации:
 *   1 токен ≈ 4 символа (латиница, кириллица, пробелы, спецсимволы).
 *   Цифры: 1–3 цифры на токен (год 2026 ≈ 1 токен).
 *   Пробелы, табуляция, знаки препинания — считаются.
 *
 * @param {string} text — входной текст (промпт, ответ)
 * @returns {number} — приблизительное количество токенов
 */
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

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
    const inputRate = tokensIn > GEMINI_SHORT_CONTEXT_LIMIT
      ? PRICES.gemini.input_long
      : PRICES.gemini.input_short;
    return tokensIn * inputRate + tokensOut * PRICES.gemini.output;
  }

  return 0;
}

/**
 * Форматирует стоимость для отображения (напр. "$0.0142").
 */
function formatCost(usd) {
  return `$${usd.toFixed(4)}`;
}

module.exports = { calcCost, formatCost, estimateTokens, PRICES, GEMINI_SHORT_CONTEXT_LIMIT };
