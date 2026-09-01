'use strict';

/**
 * Deterministic LLM pricing calculator.
 *
 * DeepSeek V4 official pricing (USD per 1M tokens):
 *   V4 Flash: hit 0.007/0.014, miss 0.22/0.44, output 0.66/1.32
 *   V4 Pro:   hit 0.022/0.044, miss 0.66/1.32, output 1.98/3.96
 * The first value is off-peak and the second is peak.
 * Official peak hours are 01:00–04:00 and 06:00–10:00 UTC.
 *
 * The calculator uses returned provider usage for billing. estimateTokens is
 * only an approximate pre-call guard and must never replace returned usage.
 */

const MILLION = 1_000_000;
const DEEPSEEK_PEAK_HOURS_UTC = Object.freeze([
  Object.freeze([1, 4]),
  Object.freeze([6, 10]),
]);

const PRICES = {
  deepseek_v4_flash: {
    model: 'deepseek-v4-flash',
    input_cache_hit: { off_peak: 0.007 / MILLION, peak: 0.014 / MILLION },
    input_cache_miss: { off_peak: 0.22 / MILLION, peak: 0.44 / MILLION },
    output: { off_peak: 0.66 / MILLION, peak: 1.32 / MILLION },
  },
  deepseek_v4_pro: {
    model: 'deepseek-v4-pro',
    input_cache_hit: { off_peak: 0.022 / MILLION, peak: 0.044 / MILLION },
    input_cache_miss: { off_peak: 0.66 / MILLION, peak: 1.32 / MILLION },
    output: { off_peak: 1.98 / MILLION, peak: 3.96 / MILLION },
  },
  // Backward-compatible aliases. The actual tier is resolved from the model
  // name or DEEPSEEK_MODEL; bare `deepseek` therefore follows the configured
  // runtime model rather than an obsolete hard-coded rate.
  deepseek: null,
  deepseek_reasoner: null,
  'deepseek-reasoner': null,
  gemini: {
    input_short: 2.00 / MILLION,
    output_short: 12.00 / MILLION,
    cached_input_short: 0.50 / MILLION,
    input_long: 4.00 / MILLION,
    output_long: 18.00 / MILLION,
    cached_input_long: 1.00 / MILLION,
  },
  grok: {
    input: 2.00 / MILLION,
    output: 6.00 / MILLION,
  },
  openai_gpt_5_nano: { model: 'gpt-5-nano', input: 0.05 / MILLION, output: 0.40 / MILLION },
  openai_gpt_5_mini: { model: 'gpt-5-mini', input: 0.25 / MILLION, output: 2.00 / MILLION },
  openai_gpt_5:      { model: 'gpt-5',      input: 1.25 / MILLION, output: 10.00 / MILLION },
  openai_gpt_5_5:    { model: 'gpt-5.5',    input: 5.00 / MILLION, output: 30.00 / MILLION },
};

const GEMINI_SHORT_CONTEXT_LIMIT = 200_000;

function _finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _nonNegative(value) {
  return Math.max(0, _finiteNumber(value, 0));
}

function normalizeDeepSeekModel(model) {
  const requested = String(model || '').trim().toLowerCase();
  const raw = (requested === '' || requested === 'deepseek')
    ? String(process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro').trim().toLowerCase()
    : requested;
  if (raw.includes('flash')) return 'deepseek_v4_flash';
  // V4 Pro, R1/reasoner and the old bare provider name are charged using the
  // current DeepSeek Pro tier when no more specific tier is available.
  return 'deepseek_v4_pro';
}

function getDeepSeekPricingMode(now = new Date()) {
  const configured = String(process.env.DEEPSEEK_PRICING_MODE || 'auto')
    .trim()
    .toLowerCase();
  if (configured === 'peak') return 'peak';
  if (configured === 'off_peak' || configured === 'off-peak' || configured === 'offpeak') {
    return 'off_peak';
  }

  const hour = now instanceof Date && !Number.isNaN(now.getTime())
    ? now.getUTCHours()
    : new Date().getUTCHours();
  return DEEPSEEK_PEAK_HOURS_UTC.some(([from, to]) => hour >= from && hour < to)
    ? 'peak'
    : 'off_peak';
}

function _clampTokens(value, total) {
  return Math.min(Math.max(0, _finiteNumber(value, 0)), Math.max(0, total));
}

/**
 * Splits DeepSeek input usage into cached and non-cached tokens.
 * `prompt_cache_hit_tokens` and `prompt_cache_miss_tokens` are partial counts;
 * a hit must not discount the entire prompt. Legacy boolean cacheHit remains
 * supported and means the entire input was reported as cached.
 */
function splitDeepSeekInput(tokensIn, usage = {}) {
  const total = _nonNegative(tokensIn);
  const hasHitCount = usage.cacheHitTokens != null || usage.cachedTokens != null;
  const hasMissCount = usage.cacheMissTokens != null;
  const hitRaw = hasHitCount
    ? (usage.cacheHitTokens != null ? usage.cacheHitTokens : usage.cachedTokens)
    : (usage.cacheHit ? total : 0);
  const hit = _clampTokens(hitRaw, total);
  const remaining = Math.max(0, total - hit);
  const miss = hasMissCount
    ? Math.min(remaining, _nonNegative(usage.cacheMissTokens))
    : remaining;
  // If a provider omits one side of the split, assign all residual input to
  // miss so the billed input total always equals prompt_tokens.
  return {
    cacheHitTokens: hit,
    cacheMissTokens: Math.max(0, total - hit - miss) + miss,
  };
}

function resolveDeepSeekTier(model) {
  const key = normalizeDeepSeekModel(model);
  return { key, tier: PRICES[key] };
}

function normalizeOpenAiPricingKey(model) {
  const raw = String(model || '').trim().toLowerCase();
  if (raw === 'gpt-5-nano' || raw.startsWith('gpt-5-nano-')) return 'openai_gpt_5_nano';
  if (raw === 'gpt-5-mini' || raw.startsWith('gpt-5-mini-')) return 'openai_gpt_5_mini';
  if (raw === 'gpt-5.5' || raw.startsWith('gpt-5.5-')) return 'openai_gpt_5_5';
  if (raw === 'gpt-5' || raw.startsWith('gpt-5-')) return 'openai_gpt_5';
  return null;
}

/**
 * Returns a transparent cost breakdown. All token quantities are provider-
 * returned counts, and all USD rates are per-token rates derived from the
 * official per-million-token table.
 */
function calculateCostBreakdown(model, tokensIn, tokensOut, usage = {}) {
  const input = _nonNegative(tokensIn);
  const output = _nonNegative(tokensOut);
  const thoughtsTokens = _nonNegative(usage.thoughtsTokens);

  if (String(model || '').toLowerCase().startsWith('deepseek') || model === 'deepseek') {
    const { key, tier } = resolveDeepSeekTier(model);
    const pricingMode = usage.pricingMode || getDeepSeekPricingMode(usage.now);
    const mode = pricingMode === 'peak' ? 'peak' : 'off_peak';
    const split = splitDeepSeekInput(input, usage);
    const inputHitRate = tier.input_cache_hit[mode];
    const inputMissRate = tier.input_cache_miss[mode];
    const outputRate = tier.output[mode];
    const inputCostUsd = split.cacheHitTokens * inputHitRate
      + split.cacheMissTokens * inputMissRate;
    const outputCostUsd = output * outputRate;
    return {
      provider: 'deepseek',
      modelTier: tier.model,
      pricingMode: mode,
      inputTokens: input,
      outputTokens: output,
      cacheHitTokens: split.cacheHitTokens,
      cacheMissTokens: split.cacheMissTokens,
      thoughtsTokens: 0,
      inputRateUsdPer1M: inputHitRate * MILLION,
      inputCacheMissRateUsdPer1M: inputMissRate * MILLION,
      outputRateUsdPer1M: outputRate * MILLION,
      inputCostUsd,
      outputCostUsd,
      totalUsd: inputCostUsd + outputCostUsd,
      pricingKnown: true,
      pricingSource: 'deepseek_model_pricing',
    };
  }

  const openAiKey = normalizeOpenAiPricingKey(model);
  if (openAiKey) {
    const tier = PRICES[openAiKey];
    const inputCostUsd = input * tier.input;
    const outputCostUsd = output * tier.output;
    return {
      provider: 'openai',
      modelTier: tier.model,
      pricingMode: 'catalog_standard_input_output',
      inputTokens: input,
      outputTokens: output,
      cacheHitTokens: _clampTokens(usage.cachedTokens, input),
      cacheMissTokens: Math.max(0, input - _clampTokens(usage.cachedTokens, input)),
      thoughtsTokens,
      inputRateUsdPer1M: tier.input * MILLION,
      inputCacheMissRateUsdPer1M: tier.input * MILLION,
      outputRateUsdPer1M: tier.output * MILLION,
      inputCostUsd,
      outputCostUsd,
      totalUsd: inputCostUsd + outputCostUsd,
      pricingKnown: true,
      pricingSource: 'live_model_catalog_snapshot',
    };
  }

  if (model === 'gemini') {
    const isLong = input > GEMINI_SHORT_CONTEXT_LIMIT;
    const inputRate = isLong ? PRICES.gemini.input_long : PRICES.gemini.input_short;
    const outputRate = isLong ? PRICES.gemini.output_long : PRICES.gemini.output_short;
    const cachedInputRate = isLong
      ? PRICES.gemini.cached_input_long
      : PRICES.gemini.cached_input_short;
    const cached = _clampTokens(usage.cachedTokens, input);
    const inputCostUsd = (input - cached) * inputRate + cached * cachedInputRate;
    const outputCostUsd = (output + thoughtsTokens) * outputRate;
    return {
      provider: 'gemini',
      modelTier: isLong ? 'gemini-long-context' : 'gemini-short-context',
      pricingMode: 'n/a',
      inputTokens: input,
      outputTokens: output,
      cacheHitTokens: cached,
      cacheMissTokens: Math.max(0, input - cached),
      thoughtsTokens,
      inputRateUsdPer1M: inputRate * MILLION,
      inputCacheMissRateUsdPer1M: inputRate * MILLION,
      outputRateUsdPer1M: outputRate * MILLION,
      inputCostUsd,
      outputCostUsd,
      totalUsd: inputCostUsd + outputCostUsd,
      pricingKnown: true,
      pricingSource: 'gemini_model_pricing',
    };
  }

  if (model === 'grok') {
    const inputRate = _finiteNumber(parseFloat(process.env.XAI_INPUT_PRICE_USD_PER_1M), 0) > 0
      ? parseFloat(process.env.XAI_INPUT_PRICE_USD_PER_1M) / MILLION
      : PRICES.grok.input;
    const outputRate = _finiteNumber(parseFloat(process.env.XAI_OUTPUT_PRICE_USD_PER_1M), 0) > 0
      ? parseFloat(process.env.XAI_OUTPUT_PRICE_USD_PER_1M) / MILLION
      : PRICES.grok.output;
    return {
      provider: 'grok',
      modelTier: 'grok-configured',
      pricingMode: 'n/a',
      inputTokens: input,
      outputTokens: output,
      cacheHitTokens: 0,
      cacheMissTokens: input,
      thoughtsTokens: 0,
      inputRateUsdPer1M: inputRate * MILLION,
      inputCacheMissRateUsdPer1M: inputRate * MILLION,
      outputRateUsdPer1M: outputRate * MILLION,
      inputCostUsd: input * inputRate,
      outputCostUsd: output * outputRate,
      totalUsd: input * inputRate + output * outputRate,
      pricingKnown: true,
      pricingSource: 'grok_configured_pricing',
    };
  }

  return {
    provider: 'unknown',
    modelTier: String(model || 'unknown'),
    pricingMode: 'unknown',
    inputTokens: input,
    outputTokens: output,
    cacheHitTokens: 0,
    cacheMissTokens: input,
    thoughtsTokens,
    inputCostUsd: 0,
    outputCostUsd: 0,
    totalUsd: 0,
    pricingKnown: false,
    pricingSource: 'unknown_model',
  };
}

/**
 * Backward-compatible scalar API used throughout the backend.
 * `cacheHitOrUsage` may be a legacy boolean or a usage object.
 */
function calcCost(model, tokensIn, tokensOut, cacheHitOrUsage = false) {
  const usage = cacheHitOrUsage && typeof cacheHitOrUsage === 'object'
    ? cacheHitOrUsage
    : { cacheHit: Boolean(cacheHitOrUsage) };
  return calculateCostBreakdown(model, tokensIn, tokensOut, usage).totalUsd;
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function formatCost(usd) {
  const value = _nonNegative(usd);
  if (value < 0.0001) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

module.exports = {
  calcCost,
  calculateCostBreakdown,
  formatCost,
  estimateTokens,
  splitDeepSeekInput,
  normalizeDeepSeekModel,
  getDeepSeekPricingMode,
  PRICES,
  GEMINI_SHORT_CONTEXT_LIMIT,
  DEEPSEEK_PEAK_HOURS_UTC,
};
