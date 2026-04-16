'use strict';

const axios       = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

/**
 * Базовый URL для Gemini API.
 * Позволяет перенаправить запросы через собственный прокси-сервер (GEMINI_BASE_URL в .env).
 * Если GEMINI_BASE_URL не задан — используем оффициальный Google endpoint.
 */
const GEMINI_BASE_URL =
  (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/, '');

/**
 * Собирает proxy URL из переменных окружения.
 *
 * Приоритет:
 *   1. GEMINI_PROXY_URL — полная строка http://login:password@ip:port
 *   2. GEMINI_PROXY_HOST + GEMINI_PROXY_PORT (+ опционально GEMINI_PROXY_USER / GEMINI_PROXY_PASS)
 *   3. HTTPS_PROXY / https_proxy — системная переменная
 *
 * Возвращает готовую URL-строку или пустую строку.
 */
function resolveProxyUrl() {
  // 1. Полная строка
  const full = process.env.GEMINI_PROXY_URL || '';
  if (full) return full;

  // 2. Компоненты
  const host = process.env.GEMINI_PROXY_HOST || '';
  const port = process.env.GEMINI_PROXY_PORT || '';
  if (host && port) {
    const user = process.env.GEMINI_PROXY_USER || '';
    const pass = process.env.GEMINI_PROXY_PASS || '';
    const proto = process.env.GEMINI_PROXY_PROTO || 'http';
    if (user && pass) {
      return `${proto}://${user}:${pass}@${host}:${port}`;
    }
    return `${proto}://${host}:${port}`;
  }

  // 3. Системная
  return process.env.HTTPS_PROXY || process.env.https_proxy || '';
}

/** Кэшированная URL-строка прокси (вычисляется один раз при старте) */
const RESOLVED_PROXY_URL = resolveProxyUrl();

// Стартовый лог — показывает, через что пойдут запросы
if (RESOLVED_PROXY_URL) {
  // Скрываем пароль в логе
  try {
    const u = new URL(RESOLVED_PROXY_URL);
    if (u.password) u.password = '***';
    console.log(`[gemini] Прокси включён: ${u.toString()}`);
  } catch {
    console.log(`[gemini] Прокси включён: ${RESOLVED_PROXY_URL.replace(/:([^:@]+)@/, ':***@')}`);
  }
} else {
  console.warn('[gemini] ⚠ Прокси НЕ задан! Запросы пойдут напрямую. Задайте GEMINI_PROXY_* в .env');
}

/**
 * Создаёт httpAgent из кэшированного proxy URL.
 */
function buildProxyAgent() {
  if (!RESOLVED_PROXY_URL) return undefined;
  try {
    return new HttpsProxyAgent(RESOLVED_PROXY_URL);
  } catch (e) {
    console.warn('[gemini] Неверный прокси, запросы пойдут напрямую:', e.message);
    return undefined;
  }
}

/**
 * Gemini Adapter
 *
 * @param {string} systemInstruction  — системный промпт
 * @param {string} userPrompt         — пользовательский промпт
 * @param {object} [options]
 * @param {number} [options.temperature=0.4]
 * @param {number} [options.maxTokens=16384]
 * @param {number} [options.timeoutMs=180000]   — Gemini медленнее, даём 3 мин
 *
 * @returns {Promise<{
 *   text:       string,
 *   tokensIn:   number,
 *   tokensOut:  number,
 *   model:      string,
 * }>}
 */
async function callGemini(systemInstruction, userPrompt, options = {}) {
  // Валидация входных данных
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  if ((systemInstruction + userPrompt).length > 100000) {
    throw new Error('Input text too long');
  }

  const {
    temperature = 0.4,
    maxTokens   = 16384,
    timeoutMs   = 180000,
  } = options;

  // Проверка параметров
  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  if (timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid timeout');

  // API ключ Gemini — из переменной окружения
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not set in environment variables');
  }

  const endpoint = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  const payload = {
    systemInstruction: {
      parts: [{
        text: "You are a strict REST API. Output ONLY valid JSON. Do not wrap in Markdown. " +
              "Never use trailing commas. CRITICAL RULES: " +
              "1) NEVER use double quotes inside string values (use single quotes '' instead). " +
              "2) Always enclose JSON keys in double quotes. " +
              "3) NEVER use unescaped newlines inside string values.",
      }],
    },
    contents: [{
      parts: [{
        text: systemInstruction
          ? `${systemInstruction}\n\n---\n\n${userPrompt}`
          : userPrompt,
      }],
    }],
    generationConfig: {
      temperature,
      maxOutputTokens:  maxTokens,
      responseMimeType: 'application/json',
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  // Прокси для Gemini API (из кэшированного proxy URL)
  const proxyAgent = buildProxyAgent();

  const axiosCfg   = {
    timeout:        timeoutMs,
    headers:        { 'Content-Type': 'application/json' },
    validateStatus: null,
    ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
  };

  const response = await axios.post(endpoint, payload, axiosCfg);

  if (response.status === 429 || response.status === 503) {
    const err = new Error(`Gemini rate limit / overload: HTTP ${response.status}`);
    err.status = response.status;
    throw err;
  }

  if (response.status !== 200) {
    let msg = `HTTP ${response.status}`;
    if (response.status >= 400 && response.status < 500) {
      msg = `Client error (${response.status})`;
    } else if (response.status >= 500) {
      msg = `Server error (${response.status})`;
    }
    // Включаем детали ошибки из ответа API для отладки
    const detail = response.data?.error?.message || JSON.stringify(response.data).slice(0, 300);
    throw new Error(`Gemini API error ${response.status}: ${msg} — ${detail}`);
  }

  const data      = response.data;
  const text      = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokensIn  = data?.usageMetadata?.promptTokenCount     || 0;
  const tokensOut = data?.usageMetadata?.candidatesTokenCount || 0;

  if (!text) throw new Error('Gemini returned empty response');

  return { text, tokensIn, tokensOut, model: GEMINI_MODEL };
}

module.exports = { callGemini };
