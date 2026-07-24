'use strict';

/**
 * Тарифы LLM-провайдеров (апрель 2026).
 * Источник: раздел 10 ТЗ.
 *
 * Gemini-тарифы ЗАХАРДКОЖЕНЫ по продуктовому требованию: «По такому прайсу
 * всегда считаем». Соответствующие env-переменные GEMINI_*_PRICE_USD_PER_1M*
 * больше не читаются — даже если оператор по ошибке выставит их в .env,
 * фактический расчёт стоимости останется детерминированным:
 *   до 200 000 токенов:   $2 / 1M input,  $12 / 1M output
 *   от 200 000 до 1 000 000 токенов: $4 / 1M input, $18 / 1M output
 * (output-rate включает thoughts/reasoning-токены — Gemini 2.5+ тарифицирует
 * их именно как output, см. поле thoughtsTokens в calcCost ниже).
 */

const PRICES = {
  deepseek: {
    input_cache_miss: 0.000000270,  // $0.27 / 1M tokens
    input_cache_hit:  0.000000070,  // $0.07 / 1M tokens
    output:           0.000001100,  // $1.10 / 1M tokens
  },
  // DeepSeek-reasoner (R1-серия / «pro» reasoning-эндпоинт): отдельный тариф,
  // output дороже за счёт reasoning-токенов (DeepSeek тарифицирует
  // completion_tokens целиком, включая внутренний chain-of-thought).
  // Источник: https://api-docs.deepseek.com/quick_start/pricing — апрель 2026.
  deepseek_reasoner: {
    input_cache_miss: 0.000000550,  // $0.55 / 1M tokens
    input_cache_hit:  0.000000140,  // $0.14 / 1M tokens
    output:           0.000002190,  // $2.19 / 1M tokens (incl. reasoning)
  },
  gemini: {
    // Контекст до 200 000 токенов — захардкожено, env не учитывается.
    input_short:        0.000002000,  // $2.00 / 1M input
    output_short:       0.000012000,  // $12.00 / 1M output (incl. thoughts)
    cached_input_short: 0.000000500,  // $0.50 / 1M cached input
    // Контекст от 200 000 до 1 000 000 токенов — захардкожено, env не учитывается.
    input_long:         0.000004000,  // $4.00 / 1M input
    output_long:        0.000018000,  // $18.00 / 1M output (incl. thoughts)
    cached_input_long:  0.000001000,  // $1.00 / 1M cached input
  },
  // x.ai Grok pricing (продуктовое требование апрель 2026):
  //   $2.00 / 1M input tokens, $6.00 / 1M output tokens.
  // Подтверждается env XAI_INPUT_PRICE_USD_PER_1M / XAI_OUTPUT_PRICE_USD_PER_1M
  // — переопределить при изменении тарифа без правки кода.
  grok: {
    input:  0.000002000,
    output: 0.000006000,
  },
  // Perplexity sonar-pro (Stage 0 real-time research). Ориентировочный тариф
  // (актуальная документация Perplexity 2025–2026): $3.00 / 1M input tokens,
  // $15.00 / 1M output tokens. Переопределяется env
  // PERPLEXITY_INPUT_PRICE_USD_PER_1M / PERPLEXITY_OUTPUT_PRICE_USD_PER_1M.
  perplexity: {
    input:  0.000003000,
    output: 0.000015000,
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
 * @param {'deepseek'|'gemini'|'grok'|'perplexity'} model
 * @param {number} tokensIn
 * @param {number} tokensOut
 * @param {boolean|object} [cacheHitOrUsage=false]
 *   - boolean (legacy): для DeepSeek признак cache_hit.
 *   - object  (новый формат): { cacheHit?:boolean, thoughtsTokens?:number, cachedTokens?:number }
 *     • thoughtsTokens — Gemini 2.5/3.x thinking-output, тарифицируется как output.
 *     • cachedTokens   — часть tokensIn, дисконтированная по cached-input rate.
 * @returns {number} — стоимость в USD
 */
function calcCost(model, tokensIn, tokensOut, cacheHitOrUsage = false) {
  // Backward-compat: вызов calcCost(model, in, out, true|false) трактуем как cacheHit.
  const usage = (cacheHitOrUsage && typeof cacheHitOrUsage === 'object')
    ? cacheHitOrUsage
    : { cacheHit: !!cacheHitOrUsage };

  const cacheHit       = !!usage.cacheHit;
  const thoughtsTokens = Math.max(0, Number(usage.thoughtsTokens) || 0);
  const cachedTokens   = Math.max(0, Number(usage.cachedTokens)   || 0);

  if (model === 'deepseek' || model === 'deepseek_reasoner' || model === 'deepseek-reasoner') {
    // Имя 'deepseek-reasoner' (с дефисом) — алиас для удобства вызывающего кода.
    const tier = (model === 'deepseek') ? PRICES.deepseek : PRICES.deepseek_reasoner;
    const inputRate = cacheHit ? tier.input_cache_hit : tier.input_cache_miss;
    return tokensIn * inputRate + tokensOut * tier.output;
  }

  if (model === 'gemini') {
    const isLong       = tokensIn > GEMINI_SHORT_CONTEXT_LIMIT;
    const inputRate       = isLong ? PRICES.gemini.input_long         : PRICES.gemini.input_short;
    const outputRate      = isLong ? PRICES.gemini.output_long        : PRICES.gemini.output_short;
    const cachedInputRate = isLong ? PRICES.gemini.cached_input_long  : PRICES.gemini.cached_input_short;

    // cachedTokens — это ЧАСТЬ promptTokenCount (Google API), считаем дисконт
    // только на cachedTokens, остальное (tokensIn − cachedTokens) — по обычному input rate.
    const cached    = Math.min(cachedTokens, tokensIn);
    const inputCost = (tokensIn - cached) * inputRate + cached * cachedInputRate;

    // thoughtsTokens (thinking-models) — отдельное поле, НЕ входит в candidatesTokenCount.
    // Тарифицируется как output. Если нули — формула совпадает со старой.
    const outputCost = (tokensOut + thoughtsTokens) * outputRate;
    return inputCost + outputCost;
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

  if (model === 'perplexity') {
    // Env-override: sonar-pro тариф может меняться — позволяем править без кода.
    const inputRate  = parseFloat(process.env.PERPLEXITY_INPUT_PRICE_USD_PER_1M)  > 0
      ? parseFloat(process.env.PERPLEXITY_INPUT_PRICE_USD_PER_1M)  / 1_000_000
      : PRICES.perplexity.input;
    const outputRate = parseFloat(process.env.PERPLEXITY_OUTPUT_PRICE_USD_PER_1M) > 0
      ? parseFloat(process.env.PERPLEXITY_OUTPUT_PRICE_USD_PER_1M) / 1_000_000
      : PRICES.perplexity.output;
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
