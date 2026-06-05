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
const { calcCost } = require('../metrics/priceCalculator');
const llmUsageLog = require('../aegis/llmUsageLog');
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
    const cost = calcCost('gemini', tIn, resp.tokensOut || 0, {
      cachedTokens: resp.cachedTokens || 0,
      thoughtsTokens: resp.thoughtsTokens || 0,
    });
    return { text: resp.text || '', tIn, tOut, cached: resp.cachedTokens || 0, cost, model: resp.model || g.model || 'gemini' };
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
  const costProv = _costProvider('deepseek', opts.model || d.model);
  const cost = calcCost(costProv, tIn, tOut, { cachedTokens: cached });
  return { text: resp.text || '', tIn, tOut, cached, cost, model: resp.model || d.model || 'deepseek' };
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
  const provider = resolveProvider();
  if (!provider) return { verdict: 'skipped', reason: 'no_api_key' };
  const kind = opts.kind || 'project_seo_analysis';
  const t0 = Date.now();
  try {
    const r = await _callRaw(provider, system, user, opts);
    const durationMs = Date.now() - t0;
    try {
      llmUsageLog.recordUsage({
        provider: _costProvider(provider, r.model),
        kind,
        outcome: 'ok',
        tokensIn: r.tIn,
        tokensOut: r.tOut,
        cachedTokens: r.cached,
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
  const provider = resolveProvider();
  if (!provider) throw new Error('no_api_key');
  const kind = opts.kind || 'project_seo_analysis';
  const t0 = Date.now();
  const r = await _callRaw(provider, system, user, opts);
  const durationMs = Date.now() - t0;
  try {
    llmUsageLog.recordUsage({
      provider: _costProvider(provider, r.model),
      kind,
      outcome: 'ok',
      tokensIn: r.tIn,
      tokensOut: r.tOut,
      cachedTokens: r.cached,
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

module.exports = {
  runAnalyst,
  runAnalystTracked,
  resolveProvider,
  analystAvailable,
  _stripFence,
};
