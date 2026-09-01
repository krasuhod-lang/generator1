'use strict';

/**
 * OpenAI-compatible adapter for GPT models.
 *
 * The API key is resolved from the encrypted admin integration vault first,
 * then from OPENAI_API_KEY. Provider usage is returned unchanged enough for
 * callLLM to persist authoritative prompt/completion/cache/reasoning counts.
 * Secrets and response bodies are never written to logs.
 */

const axios = require('axios');
const { getIntegrationSecret } = require('../integrations/integrationVault');

const OPENAI_BASE_URL = (
  process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
).replace(/\/+$/, '');
const DEFAULT_MODEL = String(process.env.OPENAI_MODEL || 'gpt-5').trim() || 'gpt-5';
const DEFAULT_MAX_TOKENS = Math.min(
  Math.max(Number(process.env.OPENAI_MAX_TOKENS) || 16000, 1),
  128000,
);
const DEFAULT_TIMEOUT_MS = (() => {
  const raw = Number(process.env.OPENAI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 && raw <= 600000 ? raw : 300000;
})();

function _isGpt5Model(model) {
  return /^gpt-5(?:\.|$)/i.test(String(model || ''));
}

function _safeMessage(error) {
  const status = error?.response?.status || 0;
  if (status === 401 || status === 403) return `OpenAI API error ${status}: authentication failed`;
  if (status >= 400 && status < 500) return `OpenAI API error ${status}: client request rejected`;
  if (status >= 500) return `OpenAI API error ${status}: provider server error`;
  if (error?.code === 'ECONNABORTED') return 'OpenAI API error: request timeout';
  return `OpenAI API error: ${String(error?.message || 'network error').slice(0, 240)}`;
}

function _extractText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('');
  }
  return '';
}

async function resolveOpenAiApiKey() {
  const key = await getIntegrationSecret('OPENAI_API_KEY');
  if (!key) {
    const error = new Error('OPENAI_API_KEY is not configured in admin vault or environment');
    error.isDeterministic = true;
    throw error;
  }
  return key;
}

/**
 * @param {string} systemInstruction
 * @param {string} userPrompt
 * @param {object} options
 * @returns {Promise<{text:string,tokensIn:number,tokensOut:number,model:string,finishReason:string,cachedTokens:number,reasoningTokens:number,thoughtsTokens:number}>}
 */
async function callOpenAI(systemInstruction, userPrompt, options = {}) {
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  if ((systemInstruction + userPrompt).length > 300000) {
    const error = new Error('Input text too long');
    error.isDeterministic = true;
    throw error;
  }

  const {
    temperature = 0.4,
    maxTokens = DEFAULT_MAX_TOKENS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    model = DEFAULT_MODEL,
    responseFormat = null,
    reasoningEffort = null,
  } = options;

  if (!Number.isFinite(Number(maxTokens)) || Number(maxTokens) < 1 || Number(maxTokens) > 128000) {
    throw new Error('Invalid maxTokens');
  }
  if (timeoutMs !== 0 && (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) < 1000 || Number(timeoutMs) > 600000)) {
    throw new Error('Invalid timeout');
  }

  const apiKey = await resolveOpenAiApiKey();
  const messages = [];
  if (systemInstruction.trim()) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model: String(model || DEFAULT_MODEL),
    messages,
    max_completion_tokens: Math.trunc(Number(maxTokens)),
  };

  // GPT-5 reasoning models use family-specific reasoning controls. Do not send
  // temperature for this family because some reasoning endpoints reject it.
  if (_isGpt5Model(model)) {
    if (reasoningEffort) body.reasoning = { effort: reasoningEffort };
  } else if (Number.isFinite(Number(temperature))) {
    body.temperature = Number(temperature);
  }
  if (responseFormat && typeof responseFormat === 'object') body.response_format = responseFormat;

  try {
    const response = await axios.post(`${OPENAI_BASE_URL}/chat/completions`, body, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'generator1-openai-adapter',
      },
      timeout: timeoutMs,
    });
    const data = response.data || {};
    const choice = data.choices?.[0] || {};
    const usage = data.usage || {};
    const tokensIn = Math.max(0, Number(usage.prompt_tokens) || 0);
    const tokensOut = Math.max(0, Number(usage.completion_tokens) || 0);
    const cachedTokens = Math.max(
      0,
      Number(usage.prompt_tokens_details?.cached_tokens) || Number(usage.cached_tokens) || 0,
    );
    const reasoningTokens = Math.max(
      0,
      Number(usage.completion_tokens_details?.reasoning_tokens) || Number(usage.reasoning_tokens) || 0,
    );
    const text = _extractText(choice.message);
    const finishReason = String(choice.finish_reason || '');

    if (!text.trim()) {
      const error = new Error(`OpenAI returned empty response (finish_reason=${finishReason || 'unknown'})`);
      error.isDeterministic = finishReason !== 'length';
      error.finishReason = finishReason;
      throw error;
    }

    return {
      text,
      tokensIn,
      tokensOut,
      model: data.model || model,
      cachedTokens,
      cacheHitTokens: cachedTokens,
      cacheMissTokens: Math.max(0, tokensIn - cachedTokens),
      reasoningTokens,
      // OpenAI completion_tokens already includes reasoning tokens where the
      // provider reports them; do not add thoughts twice to billing.
      thoughtsTokens: 0,
      finishReason,
    };
  } catch (error) {
    if (error?.isDeterministic) throw error;
    const wrapped = new Error(_safeMessage(error));
    wrapped.status = error?.response?.status || null;
    wrapped.code = error?.code || null;
    wrapped.isDeterministic = wrapped.status === 401 || wrapped.status === 403;
    throw wrapped;
  }
}

module.exports = {
  callOpenAI,
  resolveOpenAiApiKey,
  OPENAI_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TIMEOUT_MS,
  _internals: { _isGpt5Model, _extractText, _safeMessage },
};
