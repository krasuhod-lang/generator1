'use strict';

/**
 * projects/llmAnalyst.js — провайдер-агностичный вызов LLM для проектной
 * аналитики. По умолчанию использует Gemini 3.1 Pro (config.analyzer.gemini):
 * reasoning-модель даёт более точечный анализ срезов GSC/Яндекса, прогнозы и
 * определение слабых зон. Если Gemini не сконфигурирован (нет GEMINI_API_KEY),
 * мягко откатывается на DeepSeek-reasoner; если и его нет — возвращает
 * { verdict:'skipped' }. Никогда не бросает.
 *
 * Все вызовы возвращают свободный markdown (plainText), а не JSON, — отчёт
 * рендерится через MarkdownView на фронте.
 *
 * Возвращает нормализованный объект, совместимый с прежним deepseekAnalyzer:
 *   { verdict, markdown, tokens_in, tokens_out, cost_usd, model, duration_ms }
 */

const { callGemini } = require('../llm/gemini.adapter');
const { callDeepSeek } = require('../llm/deepseek.adapter');
const { calculateCostBreakdown } = require('../metrics/priceCalculator');
const llmUsageLog = require('../aegis/llmUsageLog');
const { getIntegrationSecretInfo } = require('../integrations/integrationVault');
const { recordProviderResponse, recordProviderFailure } = require('../metrics/providerAttemptAccounting');
const { getProjectsConfig } = require('./config');

function _hasGemini() {
  return Boolean((process.env.GEMINI_API_KEY || '').trim());
}
function _hasDeepSeek() {
  return Boolean((process.env.DEEPSEEK_API_KEY || '').trim());
}

/**
 * Определяет фактический провайдер с учётом конфигурации и наличия ключей.
 * @returns {'gemini'|'deepseek'|null}
 */
function resolveProvider() {
  const cfg = getProjectsConfig().analyzer || {};
  const want = cfg.provider === 'deepseek' ? 'deepseek' : 'gemini';
  if (want === 'gemini') {
    if (_hasGemini()) return 'gemini';
    if (_hasDeepSeek()) return 'deepseek'; // мягкий откат
    return null;
  }
  // want === 'deepseek'
  if (_hasDeepSeek()) return 'deepseek';
  if (_hasGemini()) return 'gemini';
    return null;
}

async function resolveProviderAsync() {
  const cfg = getProjectsConfig().analyzer || {};
  const want = cfg.provider === 'deepseek' ? 'deepseek' : 'gemini';
  let gemini = false;
  let deepseek = false;
  try {
    const [geminiInfo, deepseekInfo] = await Promise.all([
      getIntegrationSecretInfo('GEMINI_API_KEY'),
      getIntegrationSecretInfo('DEEPSEEK_API_KEY'),
    ]);
    gemini = Boolean(geminiInfo && geminiInfo.configured);
    deepseek = Boolean(deepseekInfo && deepseekInfo.configured);
  } catch (_) {
    // Preserve the old environment fallback if vault access is unavailable.
    gemini = _hasGemini();
    deepseek = _hasDeepSeek();
  }
  if (want === 'gemini') return gemini ? 'gemini' : (deepseek ? 'deepseek' : null);
  return deepseek ? 'deepseek' : (gemini ? 'gemini' : null);
}
/** Имя провайдера для cost-аналитики (priceCalculator/llmUsageLog). */
function _costProvider(provider, model) {
  if (provider === 'gemini') return 'gemini';
  return /reasoner|r1/i.test(String(model || '')) ? 'deepseek-reasoner' : 'deepseek';
}

function _stripFence(text) {
  if (!text) return '';
  return String(text)
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

/**
 * Низкоуровневый вызов выбранного провайдера. Возвращает «сырой» результат с
 * токенами/стоимостью. Бросает при сетевой ошибке (ловит вызывающий).
 */
async function _callRaw(provider, system, user, opts) {
  const cfg = getProjectsConfig();
  if (provider === 'gemini') {
    const g = (cfg.analyzer && cfg.analyzer.gemini) || {};
    const resp = await callGemini(system, user, {
      plainText: true,
      model: opts.model || g.model,
      temperature: opts.temperature != null ? opts.temperature : g.temperature,
      maxTokens: opts.maxTokens || g.maxTokens,
      timeoutMs: opts.timeoutMs || g.timeoutMs,
    });
    const tIn = resp.tokensIn || 0;
    const tOut = (resp.tokensOut || 0) + (resp.thoughtsTokens || 0);
    const model = resp.model || g.model || 'gemini';
    const pricing = calculateCostBreakdown('gemini', tIn, resp.tokensOut || 0, {
      cachedTokens: resp.cachedTokens || 0,
      thoughtsTokens: resp.thoughtsTokens || 0,
    });
    return {
      text: resp.text || '',
      tIn,
      tOut,
      cached: resp.cachedTokens || 0,
      cacheHitTokens: pricing.cacheHitTokens,
      cacheMissTokens: pricing.cacheMissTokens,
      pricing,
      cost: pricing.totalUsd,
      model,
    };
  }
  // deepseek
  const d = cfg.deepseek || {};
  const resp = await callDeepSeek(system, user, {
    temperature: opts.temperature != null ? opts.temperature : d.temperature,
    maxTokens: opts.maxTokens || d.maxTokens,
    timeoutMs: opts.timeoutMs || d.timeoutMs,
    model: opts.model || d.model,
  });
  const tIn = resp.tokensIn || 0;
  const tOut = resp.tokensOut || 0;
  const cached = resp.cacheHitTokens || 0;
  const model = resp.model || opts.model || d.model || process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
  const pricing = calculateCostBreakdown(model, tIn, tOut, {
    cacheHitTokens: cached,
    cacheMissTokens: resp.cacheMissTokens,
  });
  return {
    text: resp.text || '',
    tIn,
    tOut,
    cached,
    cacheHitTokens: pricing.cacheHitTokens,
    cacheMissTokens: pricing.cacheMissTokens,
    pricing,
    cost: pricing.totalUsd,
    model,
  };
}

/**
 * Основной хелпер: запускает анализ и возвращает нормализованный markdown.
 * Никогда не бросает.
 *
 * @param {string} system  системный промпт
 * @param {string} user    пользовательский промпт (срез данных)
 * @param {object} [opts]   { kind, temperature, maxTokens, timeoutMs, model }
 */
async function runAnalyst(system, user, opts = {}) {
  const provider = await resolveProviderAsync();
  if (!provider) return { verdict: 'skipped', reason: 'no_api_key' };
  const kind = opts.kind || 'project_seo_analysis';
  const t0 = Date.now();
  try {
    const r = await _callRaw(provider, system, user, opts);
    const durationMs = Date.now() - t0;
    await recordProviderResponse({
      provider,
      result: {
        model: r.model,
        tokensIn: r.tIn,
        tokensOut: r.tOut,
        cachedTokens: r.cached,
        cacheHitTokens: r.cacheHitTokens,
        cacheMissTokens: r.cacheMissTokens,
        pricing: r.pricing,
        cost: r.cost,
      },
      taskId: opts.taskId || null,
      traceTaskId: opts.traceTaskId || opts.analysisId || null,
      pipeline: opts.pipeline || 'projects',
      stageName: opts.stageName || 'project_llm_analysis',
      callLabel: opts.callLabel || kind,
      durationMs,
      promptSize: Math.ceil((String(system || '').length + String(user || '').length) / 4),
      onAttemptUsage: opts.onAttemptUsage,
      meta: { kind, direct_adapter: true },
    });
    try {
      llmUsageLog.recordUsage({
        provider: _costProvider(provider, r.model),
        kind,
        outcome: 'ok',
        tokensIn: r.tIn,
        tokensOut: r.tOut,
        model: r.model,
        cachedTokens: r.cacheHitTokens,
        cacheHitTokens: r.cacheHitTokens,
        cacheMissTokens: r.cacheMissTokens,
        thoughtsTokens: r.pricing?.thoughtsTokens || 0,
        pricingMode: r.pricing?.pricingMode,
        inputCostUsd: r.pricing?.inputCostUsd,
        outputCostUsd: r.pricing?.outputCostUsd,
        costUsd: r.cost,
        latencyMs: durationMs,
      });
    } catch (_) { /* no-op */ }
    return {
      verdict: 'ok',
      markdown: _stripFence(r.text),
      tokens_in: r.tIn,
      tokens_out: r.tOut,
      cost_usd: Math.round(r.cost * 1e6) / 1e6,
      model: r.model,
      provider,
      duration_ms: durationMs,
    };
  } catch (err) {
    await recordProviderFailure({
      provider,
      model: opts.model || null,
      taskId: opts.taskId || null,
      traceTaskId: opts.traceTaskId || opts.analysisId || null,
      pipeline: opts.pipeline || 'projects',
      stageName: opts.stageName || 'project_llm_analysis',
      callLabel: opts.callLabel || kind,
      durationMs: Date.now() - t0,
      promptSize: Math.ceil((String(system || '').length + String(user || '').length) / 4),
      error: err,
      meta: { kind, direct_adapter: true },
    });
    try {
      llmUsageLog.recordUsage({ provider: _costProvider(provider), kind, outcome: 'error' });
    } catch (_) { /* no-op */ }
    return { verdict: 'error', reason: (err && err.message) ? err.message : String(err) };
  }
}

/**
 * Низкоуровневый трекнутый вызов (для map-reduce): возвращает сырой текст +
 * метрики. Бросает при ошибке (ловит вызывающий, как в прежнем коде).
 */
async function runAnalystTracked(system, user, opts = {}) {
  const provider = await resolveProviderAsync();
  if (!provider) throw new Error('no_api_key');
  const kind = opts.kind || 'project_seo_analysis';
  const t0 = Date.now();
  let r;
  try {
    r = await _callRaw(provider, system, user, opts);
  } catch (error) {
    await recordProviderFailure({
      provider,
      model: opts.model || null,
      taskId: opts.taskId || null,
      traceTaskId: opts.traceTaskId || opts.analysisId || null,
      pipeline: opts.pipeline || 'projects',
      stageName: opts.stageName || 'project_llm_analysis_tracked',
      callLabel: opts.callLabel || kind,
      durationMs: Date.now() - t0,
      promptSize: Math.ceil((String(system || '').length + String(user || '').length) / 4),
      error,
      meta: { kind, direct_adapter: true, tracked: true },
    });
    throw error;
  }
  const durationMs = Date.now() - t0;
  await recordProviderResponse({
    provider,
    result: {
      model: r.model,
      tokensIn: r.tIn,
      tokensOut: r.tOut,
      cachedTokens: r.cached,
      cacheHitTokens: r.cacheHitTokens,
      cacheMissTokens: r.cacheMissTokens,
      pricing: r.pricing,
      cost: r.cost,
    },
    taskId: opts.taskId || null,
    traceTaskId: opts.traceTaskId || opts.analysisId || null,
    pipeline: opts.pipeline || 'projects',
    stageName: opts.stageName || 'project_llm_analysis_tracked',
    callLabel: opts.callLabel || kind,
    durationMs,
    promptSize: Math.ceil((String(system || '').length + String(user || '').length) / 4),
    onAttemptUsage: opts.onAttemptUsage,
    meta: { kind, direct_adapter: true, tracked: true },
  });
  try {
    llmUsageLog.recordUsage({
      provider: _costProvider(provider, r.model),
      kind,
      outcome: 'ok',
      tokensIn: r.tIn,
      tokensOut: r.tOut,
      model: r.model,
      cachedTokens: r.cacheHitTokens,
      cacheHitTokens: r.cacheHitTokens,
      cacheMissTokens: r.cacheMissTokens,
      thoughtsTokens: r.pricing?.thoughtsTokens || 0,
      pricingMode: r.pricing?.pricingMode,
      inputCostUsd: r.pricing?.inputCostUsd,
      outputCostUsd: r.pricing?.outputCostUsd,
      costUsd: r.cost,
      latencyMs: durationMs,
    });
  } catch (_) { /* no-op */ }
  return {
    text: _stripFence(r.text),
    tIn: r.tIn,
    tOut: r.tOut,
    cached: r.cached,
    cost: r.cost,
    model: r.model,
    provider,
    durationMs,
  };
}

/** Доступен ли хоть один провайдер (для analysisRunner — решать, запускать ли LLM). */
function analystAvailable() {
  return resolveProvider() != null;
}

async function analystAvailableAsync() {
  return (await resolveProviderAsync()) != null;
}

module.exports = {
  runAnalyst,
  runAnalystTracked,
  resolveProvider,
  resolveProviderAsync,
  analystAvailable,
  analystAvailableAsync,
  _stripFence,
};
