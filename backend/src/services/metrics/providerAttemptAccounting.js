'use strict';

const { recordApiRequest } = require('./adminApiLedger');
const { calculateCostBreakdown } = require('./priceCalculator');

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeProvider(provider) {
  return String(provider || 'unknown').trim().toLowerCase().slice(0, 64);
}

function tokenNumber(value) {
  return typeof value === 'boolean' ? 0 : Math.max(0, finite(value));
}

function normalizeUsage(provider, result = {}, fallbackModel = null) {
  const normalizedProvider = normalizeProvider(provider);
  const tokensIn = tokenNumber(result.tokensIn);
  const tokensOut = tokenNumber(result.tokensOut);
  const cachedTokens = tokenNumber(result.cachedTokens);
  const cacheHitTokens = tokenNumber(result.cacheHitTokens);
  const cacheMissTokens = tokenNumber(result.cacheMissTokens);
  const thoughtsTokens = tokenNumber(result.thoughtsTokens);
  const model = String(result.model || fallbackModel || normalizedProvider).slice(0, 160);
  const pricing = result.pricing || calculateCostBreakdown(model, tokensIn, tokensOut, {
    cacheHitTokens,
    cacheMissTokens,
    cachedTokens,
    thoughtsTokens,
  });
  return {
    model,
    tokensIn,
    tokensOut,
    cachedTokens,
    cacheHitTokens: Math.max(cacheHitTokens, tokenNumber(pricing.cacheHitTokens)),
    cacheMissTokens: Math.max(cacheMissTokens, tokenNumber(pricing.cacheMissTokens)),
    thoughtsTokens: Math.max(thoughtsTokens, tokenNumber(pricing.thoughtsTokens)),
    inputCostUsd: Math.max(0, finite(pricing.inputCostUsd)),
    outputCostUsd: Math.max(0, finite(pricing.outputCostUsd)),
    costUsd: Math.max(0, finite(result.costUsd, finite(result.cost, finite(pricing.totalUsd)))),
    pricingKnown: pricing.pricingKnown !== false,
    pricingSource: pricing.pricingSource || null,
    pricingMode: pricing.pricingMode || null,
  };
}

async function safeAttemptCallback(onAttemptUsage, provider, usage, meta = {}) {
  if (typeof onAttemptUsage !== 'function') return;
  try {
    await Promise.resolve(onAttemptUsage(
      normalizeProvider(provider),
      usage.tokensIn,
      usage.tokensOut,
      usage.costUsd,
      meta,
    ));
  } catch (_) {
    // Metrics callbacks are fail-open by contract and must never change generation.
  }
}

async function recordProviderResponse({
  provider,
  result = {},
  taskId = null,
  traceTaskId = null,
  pipeline = null,
  stageName = null,
  callLabel = null,
  attempt = 1,
  durationMs = null,
  promptSize = null,
  requestStatus = 'provider_response',
  onAttemptUsage = null,
  meta = {},
} = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const usage = normalizeUsage(normalizedProvider, result);
  const ledgerMeta = {
    usage_source: 'provider_response',
    pricing_known: usage.pricingKnown,
    pricing_source: usage.pricingSource,
    pricing_mode: usage.pricingMode,
    ...meta,
  };

  await safeAttemptCallback(onAttemptUsage, normalizedProvider, usage, {
    attempt,
    finishReason: result.finishReason || null,
    usageSource: 'provider_response',
    requestStatus,
  });

  try {
    await recordApiRequest({
      provider: normalizedProvider,
      model: usage.model,
      pipeline,
      stageName,
      callLabel,
      taskId,
      traceTaskId,
      requestStatus,
      attempt,
      durationMs,
      promptSize,
      tokensIn: usage.tokensIn,
      tokensOut: usage.tokensOut,
      cachedTokens: usage.cachedTokens,
      cacheHitTokens: usage.cacheHitTokens,
      cacheMissTokens: usage.cacheMissTokens,
      thoughtsTokens: usage.thoughtsTokens,
      inputCostUsd: usage.inputCostUsd,
      outputCostUsd: usage.outputCostUsd,
      costUsd: usage.costUsd,
      meta: ledgerMeta,
    });
  } catch (_) {
    // Ledger is best-effort; callers must retain their existing fail-open behavior.
  }
  return usage;
}

async function recordProviderFailure({
  provider,
  model = null,
  taskId = null,
  traceTaskId = null,
  pipeline = null,
  stageName = null,
  callLabel = null,
  attempt = 1,
  durationMs = null,
  promptSize = null,
  error = null,
  meta = {},
} = {}) {
  try {
    await recordApiRequest({
      provider: normalizeProvider(provider),
      model: model ? String(model).slice(0, 160) : null,
      pipeline,
      stageName,
      callLabel,
      taskId,
      traceTaskId,
      requestStatus: 'failed',
      attempt,
      durationMs,
      promptSize,
      errorCode: error?.code || error?.name || 'provider_error',
      errorMessage: error?.message || String(error || 'provider_error'),
      meta: { usage_source: 'provider_error', ...meta },
    });
  } catch (_) {
    // Best-effort observability only.
  }
}

module.exports = {
  normalizeUsage,
  recordProviderResponse,
  recordProviderFailure,
};
