'use strict';

/**
 * aegis/vllmAdapter — клиент к локальной vLLM (OpenAI-compatible API).
 *
 * Опциональный fallback. По умолчанию OFF (AEGIS_VLLM_URL пустой).
 * Если хост настроен — обращаемся как к OpenAI Chat Completions:
 *   POST {VLLM_URL}/v1/chat/completions
 *
 * vLLM можно поднять локально с Llama-3-70B-Instruct или другой
 * open-source моделью — это полностью офлайн-fallback на случай
 * падения и DeepSeek, и Gemini одновременно.
 */

const { getAegisFlags } = require('./featureFlags');
const httpClient = require('./_httpClient');

async function callVllm(systemInstruction, userPrompt, options = {}) {
  const cfg = getAegisFlags().routing;
  if (!cfg.vllmUrl) {
    const err = new Error('AEGIS_VLLM_URL not configured');
    err.statusCode = 503;
    throw err;
  }
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  const {
    temperature = 0.4,
    maxTokens   = 4000,
    timeoutMs   = 120000,
  } = options;

  const body = {
    model:    cfg.vllmModel,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user',   content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  const r = await httpClient.post(cfg.vllmUrl, '/v1/chat/completions', body, { timeoutMs });
  if (!r.ok) {
    const err = new Error(`vllm http ${r.status || r.reason}`);
    err.statusCode = r.status;
    throw err;
  }
  const body0 = r.body || {};
  const choice = (body0.choices && body0.choices[0]) || {};
  const content = (choice.message && choice.message.content) || '';
  const usage = body0.usage || {};
  return {
    content,
    text:    content,
    usage: {
      provider:   'vllm',
      model:      body0.model || cfg.vllmModel,
      tokens_in:  usage.prompt_tokens     || 0,
      tokens_out: usage.completion_tokens || 0,
      // vLLM локально → cost_usd = 0 (бесплатно для нас, только электричество).
      cost_usd:   0,
    },
  };
}

module.exports = { callVllm };
