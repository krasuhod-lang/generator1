'use strict';

/**
 * Qwen 3.8 Max research agent for Stage 0.
 *
 * This adapter intentionally uses the Alibaba Model Studio Responses API rather
 * than chat/completions, because web_search/web_extractor are tools on the
 * Responses API. The agent is bounded by time, output size and a strict JSON
 * evidence contract. It is research-only: it cannot publish, mutate tasks or
 * execute arbitrary code.
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { getIntegrationSecret } = require('../integrations/integrationVault');
const { recordApiRequest } = require('../metrics/adminApiLedger');

function normalizeResponsesBaseUrl(raw) {
  let value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) value = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
  // Alibaba's OpenAI-compatible Responses API is served from
  // /compatible-mode/v1/responses. The older /api/v1 default returns 404 for
  // this contract, so normalize legacy values instead of silently duplicating
  // or using the wrong route.
  value = value.replace(/\/responses$/i, '').replace(/\/chat\/completions$/i, '');
  value = value.replace(/\/api\/v1$/i, '/compatible-mode/v1');
  return value.replace(/\/+$/, '');
}

const BASE_URL = normalizeResponsesBaseUrl(
  process.env.QWEN_RESPONSES_BASE_URL
  || process.env.DASHSCOPE_BASE_URL
  || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
);
const DEFAULT_MODEL = 'qwen3.8-max';
const DEFAULT_TIMEOUT_MS = 7 * 60 * 1000;
const DEFAULT_MAX_OUTPUT_TOKENS = 12000;
const MAX_INPUT_CHARS = 70000;

function normalizeProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const text = raw.trim();
  if (!text) return '';
  return /^[a-z][a-z0-9+\-.]*:\/\//i.test(text) ? text : `http://${text}`;
}

function resolveProxyUrl() {
  const direct = normalizeProxyUrl(process.env.DASHSCOPE_PROXY_URL || '');
  if (direct) return direct;
  const host = String(process.env.DASHSCOPE_PROXY_HOST || '').trim();
  const port = String(process.env.DASHSCOPE_PROXY_PORT || '').trim();
  if (!host || !port) return '';
  const proto = String(process.env.DASHSCOPE_PROXY_PROTO || 'http').trim();
  const user = process.env.DASHSCOPE_PROXY_USER || '';
  const pass = process.env.DASHSCOPE_PROXY_PASS || '';
  const auth = user && pass
    ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    : '';
  return `${proto}://${auth}${host}:${port}`;
}

const PROXY_URL = resolveProxyUrl();
const PROXY_AGENT = (() => {
  if (!PROXY_URL) return undefined;
  try { return new HttpsProxyAgent(PROXY_URL); } catch (_) { return undefined; }
})();

function sanitizeError(error) {
  const status = Number(error?.response?.status || 0) || null;
  const raw = error?.response?.data;
  let detail = '';
  try { detail = typeof raw === 'string' ? raw : JSON.stringify(raw || {}); } catch (_) { detail = ''; }
  const scrub = (value) => String(value || '')
    .replace(/sk-[A-Za-z0-9]{16,}/g, '***REDACTED***')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer ***REDACTED***')
    .replace(/(api[_-]?key|apikey)=([^&\s"']+)/gi, '$1=***REDACTED***');
  return {
    status,
    message: scrub(error?.message || 'Qwen request failed'),
    detail: scrub(detail).slice(0, 800),
  };
}

function parseJsonObject(text) {
  const source = String(text || '').trim();
  if (!source) throw new Error('Qwen returned empty research content');
  const withoutFence = source.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(withoutFence); } catch (_) { /* bounded extraction below */ }
  const start = withoutFence.indexOf('{');
  const end = withoutFence.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Qwen research response is not valid JSON');
  return JSON.parse(withoutFence.slice(start, end + 1));
}

function responseText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (typeof item?.text === 'string') chunks.push(item.text);
    for (const part of Array.isArray(item?.content) ? item.content : []) {
      if (typeof part?.text === 'string') chunks.push(part.text);
    }
  }
  return chunks.join('\n');
}

function normalizeResearch(raw) {
  const asArray = (value) => Array.isArray(value) ? value.slice(0, 30) : [];
  return {
    current_stats: asArray(raw?.current_stats),
    expert_quotes: asArray(raw?.expert_quotes),
    latest_trends: asArray(raw?.latest_trends),
    legal_or_price_updates: asArray(raw?.legal_or_price_updates),
    sources: asArray(raw?.sources),
  };
}

function usageMetrics(data) {
  const usage = data?.usage || {};
  const detailsIn = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const detailsOut = usage.output_tokens_details || usage.completion_tokens_details || {};
  const tokensIn = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const tokensOut = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const cachedTokens = Number(
    usage.cached_tokens ?? detailsIn.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0,
  ) || 0;
  const reasoningTokens = Number(
    usage.reasoning_tokens ?? detailsOut.reasoning_tokens ?? 0,
  ) || 0;
  return {
    raw: usage,
    tokensIn: Math.max(0, tokensIn),
    tokensOut: Math.max(0, tokensOut),
    cachedTokens: Math.max(0, cachedTokens),
    reasoningTokens: Math.max(0, reasoningTokens),
    totalTokens: Math.max(0, Number(usage.total_tokens || tokensIn + tokensOut) || 0),
    providerCostUsd: Number(usage.cost_usd ?? usage.cost ?? data?.cost_usd ?? 0) || 0,
  };
}

const SYSTEM_PROMPT = `You are a senior SEO research agent. You have web_search and web_extractor tools.
Your job is to collect fresh, source-grounded evidence for a Russian SEO content pipeline.
Never invent a statistic, quote, legal update, price, date, company fact or trend.
Use primary and authoritative sources first: official organizations, regulators, standards,
recognized research, official company documentation, then high-quality industry sources.
Every factual item must contain a source URL and a short exact quote or extract.
If a claim cannot be verified, omit it. Do not use competitor marketing copy as proof of an
independent fact. Search and extraction are research only: do not publish, write files, mutate
external systems or execute arbitrary code. Return ONLY JSON matching the requested shape.`;

function buildPrompt({ task, existingEvidence = '' } = {}) {
  const compactEvidence = String(existingEvidence || '').slice(0, 24000);
  return `Research task:
- topic/service: ${task?.input_target_service || ''}
- target URL: ${task?.input_target_url || ''}
- region: ${task?.input_region || 'Russia'}
- language: ${task?.input_language || 'ru'}
- business type: ${task?.input_business_type || ''}
- site type: ${task?.input_site_type || ''}
- audience: ${task?.input_target_audience || ''}
- business goal: ${task?.input_business_goal || ''}
- monetization: ${task?.input_monetization || ''}

Search for current evidence that can improve the article and E-E-A-T. Prioritize:
1) verifiable statistics and dates relevant to the topic;
2) expert or institutional statements;
3) current trends and demand signals;
4) current legal, regulatory or pricing changes when relevant;
5) source pages that clarify the search intent and terminology.
Use no more than 10 focused search iterations and stop when the evidence categories are covered.
Return this exact JSON shape. Use [] when a category has no verified evidence:
{
  "current_stats": [{"fact":"...","value":"...","source_url":"...","quote":"...","published_at":null,"confidence":0.0}],
  "expert_quotes": [{"speaker":"...","organization":"...","quote":"...","source_url":"...","published_at":null}],
  "latest_trends": [{"trend":"...","evidence":"...","source_url":"...","published_at":null}],
  "legal_or_price_updates": [{"topic":"...","change":"...","effective_at":null,"source_url":"...","quote":"..."}],
  "sources": [{"url":"...","title":"...","source_type":"official|regulator|research|industry|community","accessed_at":"..."}]
}
No markdown and no text outside JSON.

Existing scraped evidence for cross-checking (not authoritative by itself):
${compactEvidence || '[none]'}`;
}

async function runQwenResearchAgent({ task, existingEvidence = '', taskId = null, log = null, onTokens = null } = {}) {
  const startedAt = Date.now();
  const apiKey = await getIntegrationSecret('DASHSCOPE_API_KEY');
  if (!apiKey) throw new Error('DASHSCOPE_API_KEY is not configured for Qwen research agent');

  const model = String(process.env.QWEN_RESEARCH_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const timeoutMs = Math.min(
    Math.max(Number(process.env.QWEN_RESEARCH_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS, 30_000),
    DEFAULT_TIMEOUT_MS,
  );
  const maxOutputTokens = Math.min(
    Math.max(Number(process.env.QWEN_RESEARCH_MAX_OUTPUT_TOKENS) || DEFAULT_MAX_OUTPUT_TOKENS, 2000),
    DEFAULT_MAX_OUTPUT_TOKENS,
  );
  const prompt = buildPrompt({ task, existingEvidence });
  if (prompt.length > MAX_INPUT_CHARS) throw new Error('Qwen research input exceeds bounded limit');

  const body = {
    model,
    input: `${SYSTEM_PROMPT}\n\n${prompt}`,
    tools: [
      { type: 'web_search' },
      { type: 'web_extractor' },
    ],
    max_output_tokens: maxOutputTokens,
  };

  let response;
  try {
    response = await axios.post(`${BASE_URL}/responses`, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
      timeout: timeoutMs,
      ...(PROXY_AGENT ? { httpAgent: PROXY_AGENT, httpsAgent: PROXY_AGENT, proxy: false } : {}),
    });
  } catch (error) {
    const safe = sanitizeError(error);
    await recordApiRequest({
      provider: 'qwen', model, pipeline: 'seo', stageName: 'stage0',
      callLabel: 'Stage 0 Qwen Research Agent', taskId, requestStatus: 'error',
      httpStatus: safe.status, durationMs: Date.now() - startedAt,
      promptSize: prompt.length, errorCode: error.code || `HTTP_${safe.status || 'NETWORK'}`,
      errorMessage: safe.message, meta: { tools: ['web_search', 'web_extractor'] },
    });
    throw new Error(`Qwen research API error${safe.status ? ` ${safe.status}` : ''}: ${safe.message}`);
  }

  const metrics = usageMetrics(response.data);
  const text = responseText(response.data);
  let raw;
  try {
    raw = normalizeResearch(parseJsonObject(text));
  } catch (error) {
    await recordApiRequest({
      provider: 'qwen', model, pipeline: 'seo', stageName: 'stage0',
      callLabel: 'Stage 0 Qwen Research Agent', taskId, requestStatus: 'invalid_response',
      httpStatus: response.status, durationMs: Date.now() - startedAt,
      promptSize: prompt.length, tokensIn: metrics.tokensIn, tokensOut: metrics.tokensOut,
      cachedTokens: metrics.cachedTokens, thoughtsTokens: metrics.reasoningTokens,
      costUsd: metrics.providerCostUsd,
      errorCode: 'invalid_json', errorMessage: error.message,
      meta: { tools: ['web_search', 'web_extractor'], finish_reason: response.data?.status || null },
    });
    throw error;
  }

  const usagePayload = {
    provider: 'qwen',
    model,
    pipeline: 'seo',
    stageName: 'stage0',
    callLabel: 'Stage 0 Qwen Research Agent',
    taskId,
    requestStatus: 'success',
    httpStatus: response.status,
    durationMs: Date.now() - startedAt,
    promptSize: prompt.length,
    tokensIn: metrics.tokensIn,
    tokensOut: metrics.tokensOut,
    cachedTokens: metrics.cachedTokens,
    cacheHitTokens: metrics.cachedTokens,
    cacheMissTokens: Math.max(0, metrics.tokensIn - metrics.cachedTokens),
    thoughtsTokens: metrics.reasoningTokens,
    costUsd: metrics.providerCostUsd,
    meta: {
      tools: ['web_search', 'web_extractor'],
      output_limit: maxOutputTokens,
      sources_count: raw.sources.length,
      billing: metrics.providerCostUsd > 0 ? 'provider_reported' : 'not_reported_by_provider',
    },
  };
  await recordApiRequest(usagePayload);
  if (typeof onTokens === 'function') {
    onTokens({
      provider: 'qwen', model,
      tokensIn: metrics.tokensIn, tokensOut: metrics.tokensOut,
      totalTokens: metrics.totalTokens, costUsd: metrics.providerCostUsd,
    });
  }
  if (typeof log === 'function') {
    log(`Stage 0 Qwen Research Agent: ${raw.sources.length} источников, ${metrics.tokensIn + metrics.tokensOut} токенов`, 'success');
  }
  return { raw, provider: 'qwen', model, usage: metrics };
}

module.exports = {
  DEFAULT_MODEL,
  BASE_URL,
  normalizeResponsesBaseUrl,
  runQwenResearchAgent,
  buildPrompt,
  parseJsonObject,
  normalizeResearch,
};
