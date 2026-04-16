'use strict';

const axios       = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GEMINI_MODEL = 'gemini-3.1-pro-preview';

/**
 * Базовый URL для Gemini API.
 * Позволяет перенаправить запросы через собственный прокси-сервер (GEMINI_BASE_URL в .env).
 * Если GEMINI_BASE_URL не задан — используем оффициальный Google endpoint.
 */
const GEMINI_BASE_URL =
  (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/, '');

/**
 * Создаёт httpAgent если HTTPS_PROXY задан в окружении.
 * Формат: http://login:password@ip:port
 */
function buildProxyAgent() {
  const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || '';
  if (!proxyUrl) return undefined;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn('[gemini] Неверный HTTPS_PROXY, прокси отключён:', e.message);
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

  // API ключ Gemini зашифрован в base64 для защиты от случайного просмотра
  const apiKey = Buffer.from('QUl6YVN5RHd0T0NoTlgtQjNoTExBZHhrU2tJa09oV3d3UmZubVZn', 'base64').toString('utf8');

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
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_NONE' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_NONE' },
    ],
  };

  // Всегда используем прокси для Gemini API
  const proxyUrl = 'http://76MkBTXZ:3ukb66G1@155.212.59.188:64464';
  let proxyAgent;
  try {
    proxyAgent = new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn('[gemini] Неверный прокси, запросы пойдут напрямую:', e.message);
    proxyAgent = undefined;
  }

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
    if (status >= 400 && status < 500) {
      msg = `Client error (${status})`;
    } else if (status >= 500) {
      msg = `Server error (${status})`;
    }
    throw new Error(`Gemini API error ${response.status}: ${msg}`);
  }

  const data      = response.data;
  const text      = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  const tokensIn  = data?.usageMetadata?.promptTokenCount     || 0;
  const tokensOut = data?.usageMetadata?.candidatesTokenCount || 0;

  if (!text) throw new Error('Gemini returned empty response');

  return { text, tokensIn, tokensOut, model: GEMINI_MODEL };
}

module.exports = { callGemini };
