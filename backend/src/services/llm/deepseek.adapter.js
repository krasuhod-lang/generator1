'use strict';

const axios = require('axios');

const DEEPSEEK_ENDPOINT = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL    = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

async function callDeepSeek(systemInstruction, userPrompt, options = {}) {
  // Валидация входных данных
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  if (systemInstruction.length > 10000 || userPrompt.length > 50000) {
    throw new Error('Input text too long');
  }

  const {
    temperature = 0.4,
    maxTokens   = 8000,
    timeoutMs   = 120000,
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

  const body = {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userPrompt }
    ],
    temperature: temperature,
    max_tokens: maxTokens,
  };

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
    const text = data.choices?.[0]?.message?.content || '';
    const usage = data.usage || {};

    return {
      text,
      tokensIn:  usage.prompt_tokens      || 0,
      tokensOut: usage.completion_tokens || 0,
      model:      data.model              || DEEPSEEK_MODEL
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

module.exports = { callDeepSeek };
