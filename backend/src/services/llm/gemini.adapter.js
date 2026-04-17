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
 * @param {string} suffix — '' для основного прокси, '_2' для запасного
 *
 * Приоритет:
 *   1. GEMINI_PROXY_URL[suffix] — полная строка http://login:password@ip:port
 *   2. GEMINI_PROXY_HOST[suffix] + GEMINI_PROXY_PORT[suffix] (+ опционально USER / PASS)
 *   3. (только для основного) HTTPS_PROXY / https_proxy — системная переменная
 *
 * Возвращает готовую URL-строку или пустую строку.
 */
function resolveProxyUrl(suffix = '') {
  // 1. Полная строка
  const full = process.env[`GEMINI_PROXY_URL${suffix}`] || '';
  if (full) return full;

  // 2. Компоненты
  const host = process.env[`GEMINI_PROXY_HOST${suffix}`] || '';
  const port = process.env[`GEMINI_PROXY_PORT${suffix}`] || '';
  if (host && port) {
    const user = process.env[`GEMINI_PROXY_USER${suffix}`] || '';
    const pass = process.env[`GEMINI_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`GEMINI_PROXY_PROTO${suffix}`] || 'http';
    if (user && pass) {
      return `${proto}://${user}:${pass}@${host}:${port}`;
    }
    return `${proto}://${host}:${port}`;
  }

  // 3. Системная (только для основного прокси)
  if (!suffix) {
    return process.env.HTTPS_PROXY || process.env.https_proxy || '';
  }

  return '';
}

/**
 * Маскирует пароль в URL прокси для безопасного логирования.
 */
function maskProxyUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:([^:@]+)@/, ':***@');
  }
}

/** Кэшированные URL-строки прокси (вычисляются один раз при старте) */
const PROXY_PRIMARY  = resolveProxyUrl('');
const PROXY_BACKUP   = resolveProxyUrl('_2');

/**
 * Упорядоченный список доступных прокси.
 * Индекс activeProxyIdx указывает на текущий «предпочитаемый» прокси;
 * при geo-ошибке сдвигается к следующему.
 */
const PROXY_LIST = [PROXY_PRIMARY, PROXY_BACKUP].filter(Boolean);

/** Индекс текущего активного прокси (сдвигается при geo-ошибке) */
let activeProxyIdx = 0;

// Стартовый лог — показывает, через что пойдут запросы
if (PROXY_LIST.length >= 2) {
  console.log(`[gemini] Прокси основной: ${maskProxyUrl(PROXY_LIST[0])}`);
  console.log(`[gemini] Прокси запасной: ${maskProxyUrl(PROXY_LIST[1])}`);
} else if (PROXY_LIST.length === 1) {
  console.log(`[gemini] Прокси включён: ${maskProxyUrl(PROXY_LIST[0])}`);
  console.warn('[gemini] ⚠ Запасной прокси НЕ задан. Задайте GEMINI_PROXY_*_2 в .env');
} else {
  console.warn('[gemini] ⚠ Прокси НЕ задан! Запросы пойдут напрямую. Задайте GEMINI_PROXY_* в .env');
}

/**
 * Создаёт httpAgent для указанного proxy URL.
 */
function buildProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  try {
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    console.warn(`[gemini] Неверный прокси ${maskProxyUrl(proxyUrl)}, пропуск:`, e.message);
    return undefined;
  }
}

/**
 * Определяет, является ли ответ ошибкой гео-ограничения Google.
 */
function isGeoRestrictionError(response) {
  if (!response || response.status !== 400) return false;
  const detail = response.data?.error?.message || '';
  return detail.includes('User location is not supported');
}

/**
 * Выполняет один HTTP-запрос к Gemini API с указанным прокси.
 *
 * @param {string} endpoint  — URL эндпоинта Gemini
 * @param {object} payload   — тело запроса
 * @param {string} proxyUrl  — URL прокси (пустая строка = без прокси)
 * @param {number} timeoutMs — таймаут
 * @returns {Promise<import('axios').AxiosResponse>}
 */
async function executeGeminiRequest(endpoint, payload, proxyUrl, timeoutMs) {
  const proxyAgent = buildProxyAgent(proxyUrl);

  const axiosCfg = {
    timeout:        timeoutMs,
    headers:        { 'Content-Type': 'application/json' },
    validateStatus: null,
    ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
  };

  return axios.post(endpoint, payload, axiosCfg);
}

/**
 * Gemini Adapter с поддержкой двух прокси (основной + запасной).
 *
 * Логика:
 *   1. Запрос идёт через текущий активный прокси (activeProxyIdx).
 *   2. Если получаем geo-ошибку (400 «User location is not supported»),
 *      автоматически переключаемся на следующий прокси и повторяем.
 *   3. Если все прокси исчерпаны — выбрасываем ошибку.
 *   4. Удачный прокси запоминается как активный для последующих вызовов.
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

  // ── Попытки через доступные прокси ─────────────────────────────────
  // Если прокси не настроены — идём напрямую (единственная попытка).
  if (PROXY_LIST.length === 0) {
    const response = await executeGeminiRequest(endpoint, payload, '', timeoutMs);
    return handleGeminiResponse(response);
  }

  // Начинаем с текущего активного прокси, при geo-ошибке переключаемся.
  const startIdx = activeProxyIdx;
  let lastGeoError = null;

  for (let i = 0; i < PROXY_LIST.length; i++) {
    const proxyIdx = (startIdx + i) % PROXY_LIST.length;
    const proxyUrl = PROXY_LIST[proxyIdx];

    const response = await executeGeminiRequest(endpoint, payload, proxyUrl, timeoutMs);

    // Geo-ограничение → пробуем следующий прокси
    if (isGeoRestrictionError(response)) {
      const detail = response.data?.error?.message || '';
      lastGeoError = new Error(`Gemini API error 400: Client error (400) — ${detail}`);
      lastGeoError.status = 400;
      console.warn(`[gemini] Прокси ${proxyIdx + 1} (${maskProxyUrl(proxyUrl)}) — geo-ограничение, переключение...`);
      continue;
    }

    // Успешный или иной (не geo) ответ — запоминаем рабочий прокси
    activeProxyIdx = proxyIdx;
    if (proxyIdx !== startIdx) {
      console.log(`[gemini] Активный прокси переключён на ${proxyIdx + 1} (${maskProxyUrl(proxyUrl)})`);
    }

    return handleGeminiResponse(response);
  }

  // Все прокси дали geo-ошибку
  throw lastGeoError || new Error('Gemini API: все прокси вернули geo-ограничение');
}

/**
 * Обрабатывает ответ Gemini API (общая логика для любого прокси).
 */
function handleGeminiResponse(response) {
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
