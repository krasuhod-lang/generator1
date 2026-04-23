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
    // Контекст до 200K токенов
    input_short:   0.000002000,  // $2.00  / 1M tokens (≤200K context)
    output_short:  0.000012000,  // $12.00 / 1M tokens (≤200K context)
    // Контекст свыше 200K токенов
    input_long:    0.000004000,  // $4.00  / 1M tokens (>200K context)
    output_long:   0.000018000,  // $18.00 / 1M tokens (>200K context)
  },
  // x.ai Grok pricing (продуктовое требование апрель 2026):
  //   $2.00 / 1M input tokens, $6.00 / 1M output tokens.
  // Подтверждается env XAI_INPUT_PRICE_USD_PER_1M / XAI_OUTPUT_PRICE_USD_PER_1M
  // — переопределить при изменении тарифа без правки кода.
  grok: {
    input:  0.000002000,
    output: 0.000006000,
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
    const isLong    = tokensIn > GEMINI_SHORT_CONTEXT_LIMIT;
    const inputRate  = isLong ? PRICES.gemini.input_long  : PRICES.gemini.input_short;
    const outputRate = isLong ? PRICES.gemini.output_long : PRICES.gemini.output_short;
    return tokensIn * inputRate + tokensOut * outputRate;
  }

  if (model === 'grok') {
    // Env-override: позволяет менять тариф без правки кода (x.ai периодически
    // меняет цены, особенно для новых моделей вроде grok-code-fast-1).
    const inputRate  = parseFloat(process.env.XAI_INPUT_PRICE_USD_PER_1M)  > 0
      ? parseFloat(process.env.XAI_INPUT_PRICE_USD_PER_1M)  / 1_000_000
      : PRICES.grok.input;
    const outputRate = parseFloat(process.env.XAI_OUTPUT_PRICE_USD_PER_1M) > 0
      ? parseFloat(process.env.XAI_OUTPUT_PRICE_USD_PER_1M) / 1_000_000
      : PRICES.grok.output;
    return tokensIn * inputRate + tokensOut * outputRate;
  }

  return 0;
}

/**
 * Форматирует стоимость для отображения (напр. "$0.0142").
 */
function formatCost(usd) {
  if (usd < 0.0001) return `$${usd.toFixed(6)}`;
  return `$${usd.toFixed(4)}`;
}

module.exports = { calcCost, formatCost, estimateTokens, PRICES, GEMINI_SHORT_CONTEXT_LIMIT };
