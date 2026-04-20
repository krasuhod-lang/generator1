'use strict';

const axios = require('axios');

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL    = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

/**
 * Определяет, является ли модель DeepSeek-R1 (reasoning model).
 * Для R1 моделей рекомендуется избегать системных промптов —
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
    maxTokens   = 8000,
    timeoutMs   = 120000,
    logprobs    = false,
  } = options;

  // Проверка параметров
  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  if (timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid timeout');

  // API ключ DeepSeek — из переменной окружения
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is not set in environment variables');
  }

  // ── R1 (reasoning) модель: system prompt → user prompt ────────────
  // DeepSeek-R1 рекомендует не использовать system prompt.
  // Все жёсткие SEO-инструкции передаём в user prompt с XML-тегами.
  const r1Mode = isReasoningModel(DEEPSEEK_MODEL);

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
    model: DEEPSEEK_MODEL,
    messages,
    temperature: temperature,
    max_tokens: maxTokens,
  };

  if (logprobs) {
    body.logprobs = true;
    body.top_logprobs = 3;
  }

  const url = `${DEEPSEEK_ENDPOINT}/chat/completions`;

  try {
    const res = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
        'User-Agent': 'axios/1.7.2'
      },
      timeout: timeoutMs,
    });

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
      model:     data.model               || DEEPSEEK_MODEL,
      cacheHitTokens: usage.prompt_cache_hit_tokens || 0,
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

module.exports = { callDeepSeek, isReasoningModel };
