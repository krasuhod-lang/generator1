'use strict';

const axios = require('axios');
const { getIntegrationSecret } = require('../integrations/integrationVault');

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
// Все аналитические функции пайплайнов идут через DeepSeek-V4-Pro
// (копирайтинг — через Gemini, см. geminiModels.js).
const DEEPSEEK_MODEL    = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
// Дефолтный лимит выходных токенов. 8000 обрезал крупные JSON-ответы —
// увеличен до 16000; можно переопределить через .env.
const DEEPSEEK_DEFAULT_MAX_TOKENS = Math.min(
  Math.max(Number(process.env.DEEPSEEK_MAX_TOKENS) || 16000, 1),
  32000,
);

/**
 * Определяет, является ли модель DeepSeek reasoning-моделью (R1/reasoner).
 * Для reasoning-моделей рекомендуется избегать системных промптов —
 * все инструкции передаются в user prompt.
 */
function isReasoningModel(model) {
  const m = (model || '').toLowerCase();
  return m.includes('r1') || m.includes('reasoner');
}

async function callDeepSeek(systemInstruction, userPrompt, options = {}) {
  // Валидация входных данных
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  if (systemInstruction.length > 30000 || userPrompt.length > 100000) {
    throw new Error('Input text too long');
  }

  const {
    temperature = 0.4,
    maxTokens   = DEEPSEEK_DEFAULT_MAX_TOKENS,
    timeoutMs   = 120000,
    logprobs    = false,
    model       = DEEPSEEK_MODEL,
    responseFormat = null,
  } = options;

  // Проверка параметров
  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  // timeoutMs = 0 → без ограничения по времени (axios: timeout 0 = disabled)
  if (timeoutMs !== 0 && timeoutMs < 1000) throw new Error('Invalid timeout');

  // API ключ DeepSeek: admin vault → env fallback.
  const apiKey = await getIntegrationSecret('DEEPSEEK_API_KEY');
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not configured in admin vault or environment');
  }

  // ── R1 / reasoner: system prompt → user prompt ─────────────────────
  // DeepSeek-reasoner и R1 рекомендуют не использовать system prompt.
  // Все жёсткие инструкции передаём в user prompt с XML-тегами.
  const r1Mode = isReasoningModel(model);

  let messages;
  if (r1Mode && systemInstruction.trim()) {
    // Объединяем system + user в один user prompt
    messages = [
      {
        role: 'user',
        content:
          `<instructions>\n${systemInstruction}\n</instructions>\n\n${userPrompt}`,
      },
    ];
  } else if (systemInstruction.trim()) {
    messages = [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt },
    ];
  } else {
    messages = [
      { role: 'user', content: userPrompt },
    ];
  }

  const body = {
    model,
    messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };

  // DeepSeek-compatible JSON mode is opt-in so legacy calls keep their
  // existing response behavior. Stage 4/re-audit use it for compact audits.
  if (responseFormat && typeof responseFormat === 'object') {
    body.response_format = responseFormat;
  }

  if (logprobs) {
    body.logprobs = true;
    body.top_logprobs = 3;
  }

  const url = `${DEEPSEEK_ENDPOINT}/chat/completions`;

  try {
    const requestConfig = {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'User-Agent': 'axios/1.7.2'
      },
      timeout: timeoutMs,
    };

    let res;
    try {
      res = await axios.post(url, body, requestConfig);
    } catch (firstErr) {
      // Some DeepSeek-compatible gateways may reject response_format even
      // though the provider supports regular chat completions. Retry once
      // without JSON mode; callLLM still applies compact parsing/repair.
      if (responseFormat && firstErr.response?.status === 400) {
        const legacyBody = { ...body };
        delete legacyBody.response_format;
        res = await axios.post(url, legacyBody, requestConfig);
      } else {
        throw firstErr;
      }
    }

    const data = res.data;
    let text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};

    // Для R1 моделей: вырезаем <think>…</think> блок рассуждений,
    // оставляем только финальный ответ для JSON-парсинга.
    if (r1Mode) {
      text = stripThinkBlocks(text);
    }

    const logprobsData = logprobs ? (data.choices?.[0]?.logprobs?.content || null) : null;

    return {
      text,
      tokensIn:  usage.prompt_tokens      || 0,
      tokensOut: usage.completion_tokens   || 0,
      model:     data.model               || model,
      cacheHitTokens: usage.prompt_cache_hit_tokens || 0,
      cacheMissTokens: usage.prompt_cache_miss_tokens != null
        ? usage.prompt_cache_miss_tokens
        : Math.max(0, (usage.prompt_tokens || 0) - (usage.prompt_cache_hit_tokens || 0)),
      reasoningTokens: usage.completion_tokens_details?.reasoning_tokens || 0,
      // Alias used by shared billing telemetry; DeepSeek output already includes
      // reasoning tokens in completion_tokens and must not be added twice.
      thoughtsTokens: 0,
      // finish_reason = 'length' → ответ обрезан лимитом max_tokens (аналог
      // Gemini MAX_TOKENS). Пробрасываем наверх, чтобы вызывающая сторона
      // могла повысить лимит и повторить запрос, а не падать на JSON.parse.
      finishReason: data.choices?.[0]?.finish_reason || '',
      logprobs: logprobsData,
    };
  } catch (err) {
    const status = err.response?.status || 0;
    let msg = 'Unknown error';

    if (err.code === 'ECONNABORTED') {
      msg = 'Request timeout';
    } else if (status >= 400 && status < 500) {
      msg = `Client error (${status})`;
    } else if (status >= 500) {
      msg = `Server error (${status})`;
    } else {
      msg = err.message || 'Network error';
    }

    // Не логируем response.data напрямую, чтобы не раскрыть чувствительную информацию
    throw new Error(`DeepSeek API error ${status}: ${msg}`);
  }
}

/**
 * stripThinkBlocks — вырезает блоки <think>…</think> из ответа R1 модели.
 * R1 помещает рассуждения (chain-of-thought) внутрь <think> тегов,
 * а финальный JSON-ответ — после них.
 */
function stripThinkBlocks(text) {
  if (!text) return text;
  // Удаляем все <think>...</think> блоки (dotAll flag /s — . включает \n)
  return text.replace(/<think>.*?<\/think>/gis, '').trim();
}

module.exports = { callDeepSeek, isReasoningModel, DEEPSEEK_DEFAULT_MAX_TOKENS };
