'use strict';

/**
 * perplexity.adapter.js — адаптер для Perplexity API (модель sonar-pro).
 *
 * Роль: «Агент-Ресёрчер» в Stage 0. В отличие от DeepSeek/Gemini, которые
 * генерируют контент из устаревшей обучающей выборки (отставание 16–18 мес.),
 * Perplexity sonar-pro выполняет реальный поиск в интернете (grounding) и
 * возвращает свежие факты, цифры, ставки, законы и цитаты экспертов на
 * текущий месяц. Это критично для YMYL-тематик и SEO-статей.
 *
 * Совместимость с интерфейсом callLLM (см. callDeepSeek/callGemini/callGrok):
 *   - принимает (systemInstruction, userPrompt, options)
 *   - возвращает { text, tokensIn, tokensOut, finishReason, model }
 *
 * Endpoint: https://api.perplexity.ai/chat/completions (OpenAI-совместимый).
 * В messages передаём system и user промпты. Обязательные параметры:
 *   model = process.env.PERPLEXITY_MODEL || 'sonar-pro'
 *   temperature = 0.2 (низкая — для фактологической точности ресёрча)
 */

const axios = require('axios');

const PERPLEXITY_ENDPOINT = (process.env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai').replace(/\/$/, '');
const PERPLEXITY_MODEL    = process.env.PERPLEXITY_MODEL || 'sonar-pro';

// Дефолтный лимит выходных токенов ресёрч-ответа (JSON с фактами/цитатами).
const PERPLEXITY_DEFAULT_MAX_TOKENS = Math.min(
  Math.max(Number(process.env.PERPLEXITY_MAX_TOKENS) || 8000, 1),
  32000,
);

async function callPerplexity(systemInstruction, userPrompt, options = {}) {
  // Валидация входных данных
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  if (systemInstruction.length > 30000 || userPrompt.length > 100000) {
    throw new Error('Input text too long');
  }

  const {
    // Обязательно 0.2 по ТЗ — но оставляем возможность override из callLLM.
    temperature = 0.2,
    maxTokens   = PERPLEXITY_DEFAULT_MAX_TOKENS,
    timeoutMs   = 120000,
    model       = PERPLEXITY_MODEL,
  } = options;

  // Проверка параметров
  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  // timeoutMs = 0 → без ограничения по времени (axios: timeout 0 = disabled)
  if (timeoutMs !== 0 && timeoutMs < 1000) throw new Error('Invalid timeout');

  // API ключ Perplexity — из переменной окружения
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) {
    throw new Error('PERPLEXITY_API_KEY is not set in environment variables');
  }

  const messages = [];
  if (systemInstruction.trim()) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const url = `${PERPLEXITY_ENDPOINT}/chat/completions`;

  try {
    const res = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey,
        'Accept': 'application/json',
        'User-Agent': 'axios/1.7.2',
      },
      timeout: timeoutMs,
    });

    const data  = res.data;
    const text  = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};

    return {
      text,
      tokensIn:  usage.prompt_tokens     || 0,
      tokensOut: usage.completion_tokens || 0,
      model:     data.model              || model,
      // finish_reason = 'length' → ответ обрезан лимитом max_tokens.
      // Пробрасываем наверх: callLLM повысит лимит и повторит запрос,
      // а не упадёт на JSON.parse обрезанного ответа.
      finishReason: data.choices?.[0]?.finish_reason || '',
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
    const e = new Error(`Perplexity API error ${status}: ${msg}`);
    e.status = status;
    throw e;
  }
}

module.exports = { callPerplexity, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_MODEL };
