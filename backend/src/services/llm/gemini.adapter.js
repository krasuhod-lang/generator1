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
 * Нормализует proxy URL из разных форматов провайдеров.
 *
 * Поддерживаемые входные форматы:
 *   - http://user:pass@host:port       — стандартный URL (без изменений)
 *   - http://user:pass:host:port        — формат «провайдера» (авто-конвертация)
 *   - user:pass:host:port               — без протокола (авто-конвертация, добавляется http://)
 *   - host:port:user:pass               — обратный формат (авто-конвертация)
 *
 * @param {string} raw — сырая строка прокси
 * @returns {string} — нормализованный URL
 */
function normalizeProxyUrl(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (!raw) return '';

  // Если уже содержит @ — это корректный URL
  if (raw.includes('@')) return raw;

  // Формат с протоколом: http://user:pass:host:port
  const withProto = raw.match(/^(https?:\/\/)([^:]+):([^:]+):([^:]+):(\d+)$/);
  if (withProto) {
    const [, proto, user, pass, host, port] = withProto;
    const normalized = `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    console.log(`[gemini] Нормализация прокси: ${proto}${user}:***@${host}:${port}`);
    return normalized;
  }

  // Формат без протокола: 4 части через двоеточие
  // user:pass:host:port  ИЛИ  host:port:user:pass
  const noParts = raw.match(/^([^:]+):([^:]+):([^:]+):([^:]+)$/);
  if (noParts) {
    const [, p1, p2, p3, p4] = noParts;
    // IP-адрес: 4 октета 0-255, разделённых точками
    const isIP = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s) && s.split('.').every(o => +o >= 0 && +o <= 255);
    // Hostname: буквы, цифры, точки, дефисы; минимум одна точка и хотя бы одна буква
    const isHostname = (s) => /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s) && s.includes('.') && /[a-zA-Z]/.test(s);
    const isHost = (s) => isIP(s) || isHostname(s);
    const isPort = (s) => /^\d+$/.test(s);

    let user, pass, host, port;
    if (isHost(p3) && isPort(p4)) {
      // user:pass:host:port
      [user, pass, host, port] = [p1, p2, p3, p4];
    } else if (isHost(p1) && isPort(p2)) {
      // host:port:user:pass
      [host, port, user, pass] = [p1, p2, p3, p4];
    } else {
      // Не удалось распознать формат — вернём как есть
      return raw;
    }
    const normalized = `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    console.log(`[gemini] Нормализация прокси: http://${user}:***@${host}:${port}`);
    return normalized;
  }

  return raw;
}

/**
 * Собирает proxy URL из переменных окружения.
 *
 * @param {string} [suffix='']  — суффикс для переменных ('' для основного, '_2' для запасного)
 *
 * Приоритет:
 *   1. GEMINI_PROXY_URL[suffix] — полная строка http://login:password@ip:port
 *      Также поддерживается формат провайдера: login:password:ip:port
 *   2. GEMINI_PROXY_HOST[suffix] + GEMINI_PROXY_PORT[suffix] (+ опционально USER / PASS)
 *   3. (только для основного) HTTPS_PROXY / https_proxy — системная переменная
 *
 * Возвращает готовую URL-строку или пустую строку.
 */
function resolveProxyUrl(suffix = '') {
  // 1. Полная строка (с автонормализацией формата)
  const full = process.env[`GEMINI_PROXY_URL${suffix}`] || '';
  if (full) return normalizeProxyUrl(full);

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

// ── Собираем список прокси (основной + запасные) ───────────────────────────
const PROXY_URLS = [];
const PRIMARY_PROXY = resolveProxyUrl('');
if (PRIMARY_PROXY) PROXY_URLS.push(PRIMARY_PROXY);

const BACKUP_PROXY = resolveProxyUrl('_2');
if (BACKUP_PROXY) PROXY_URLS.push(BACKUP_PROXY);

// Можно добавить ещё прокси (_3, _4, …) при необходимости
for (let i = 3; i <= 5; i++) {
  const px = resolveProxyUrl(`_${i}`);
  if (px) PROXY_URLS.push(px);
}

/** Индекс текущего активного прокси (запоминаем работающий) */
let activeProxyIdx = 0;

/** Безопасное логирование URL прокси (скрываем пароль) */
function safeProxyLog(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:([^:@]+)@/, ':***@');
  }
}

// Стартовый лог — показывает, через что пойдут запросы
if (PROXY_URLS.length > 0) {
  console.log(`[gemini] Прокси включён (${PROXY_URLS.length} шт):`);
  PROXY_URLS.forEach((u, i) => console.log(`  [${i}] ${safeProxyLog(u)}`));
} else {
  console.warn('[gemini] ⚠ Прокси НЕ задан! Запросы пойдут напрямую. Задайте GEMINI_PROXY_* в .env');
}

/**
 * Создаёт httpAgent для прокси по индексу.
 * @param {number} idx — индекс в PROXY_URLS
 * @returns {HttpsProxyAgent|undefined}
 */
function buildProxyAgent(idx) {
  if (idx < 0 || idx >= PROXY_URLS.length) return undefined;
  try {
    return new HttpsProxyAgent(PROXY_URLS[idx]);
  } catch (e) {
    console.warn(`[gemini] Неверный прокси [${idx}], пропускаем:`, e.message);
    return undefined;
  }
}

/**
 * Определяет, является ли ошибка гео-блокировкой.
 */
function isGeoBlockError(errMsg) {
  return errMsg.includes('User location is not supported');
}

/**
 * Gemini Adapter — с автоматическим переключением прокси при гео-блокировке.
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

  // ── Попытка с текущим активным прокси, при гео-ошибке — переключаемся ──
  const hasProxies   = PROXY_URLS.length > 0;
  const totalAttempts = hasProxies ? PROXY_URLS.length : 1; // без прокси — 1 попытка напрямую
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const proxyAgent = hasProxies
      ? buildProxyAgent((activeProxyIdx + attempt) % PROXY_URLS.length)
      : undefined;
    const proxyIdx = hasProxies ? (activeProxyIdx + attempt) % PROXY_URLS.length : -1;

    // Логируем через какой прокси идёт запрос (для диагностики)
    if (hasProxies && proxyAgent) {
      console.log(`[gemini] Запрос через прокси [${proxyIdx}] ${safeProxyLog(PROXY_URLS[proxyIdx])}`);
    } else if (hasProxies && !proxyAgent) {
      // Прокси задан, но agent не создался (невалидный URL) — НЕ отправляем напрямую!
      console.warn(`[gemini] ⚠ Прокси [${proxyIdx}] не удалось создать — пропускаем`);
      lastError = new Error(`Gemini proxy [${proxyIdx}] agent creation failed`);
      if (attempt < totalAttempts - 1) continue;
      throw lastError;
    } else {
      console.warn(`[gemini] Запрос НАПРЯМУЮ (прокси не настроен)`);
    }

    const axiosCfg = {
      timeout:        timeoutMs,
      headers:        { 'Content-Type': 'application/json' },
      validateStatus: null,
      ...(proxyAgent ? { httpsAgent: proxyAgent, proxy: false } : {}),
    };

    let response;
    try {
      response = await axios.post(endpoint, payload, axiosCfg);
    } catch (networkErr) {
      // Сетевая ошибка прокси (timeout, ECONNREFUSED и т.д.)
      // Переключаемся на следующий прокси
      const proxyLabel = hasProxies ? `прокси [${proxyIdx}] ${safeProxyLog(PROXY_URLS[proxyIdx])}` : 'напрямую';
      console.warn(`[gemini] Сетевая ошибка через ${proxyLabel}: ${networkErr.message}`);
      lastError = networkErr;

      if (attempt < totalAttempts - 1) {
        console.log(`[gemini] Переключаемся на следующий прокси...`);
        continue;
      }
      throw networkErr;
    }

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
      const proxyInfo = hasProxies ? ` [proxy ${proxyIdx}]` : ' [DIRECT/no proxy]';
      const fullMsg = `Gemini API error ${response.status}: ${msg} — ${detail}${proxyInfo}`;

      // ── Гео-блокировка → переключаем прокси ──────────────────────
      if (isGeoBlockError(detail) && attempt < totalAttempts - 1) {
        const proxyLabel = hasProxies ? safeProxyLog(PROXY_URLS[proxyIdx]) : 'напрямую';
        console.warn(`[gemini] Гео-блокировка через ${proxyLabel}. Переключаемся на следующий прокси...`);
        lastError = new Error(fullMsg);
        lastError.isGeoBlock = true;
        lastError.isDeterministic = true;
        continue;
      }

      const err = new Error(fullMsg);
      // Маркируем гео-ошибку как детерминированную — повторные ретраи бессмысленны
      if (isGeoBlockError(detail)) {
        err.isGeoBlock = true;
        err.isDeterministic = true;
      }
      throw err;
    }

    // ── Успех! Запоминаем работающий прокси ──────────────────────────
    if (hasProxies && proxyIdx !== activeProxyIdx) {
      console.log(`[gemini] Прокси [${proxyIdx}] работает — запоминаем как активный`);
      activeProxyIdx = proxyIdx;
    }

    const data      = response.data;
    const text      = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const tokensIn  = data?.usageMetadata?.promptTokenCount     || 0;
    const tokensOut = data?.usageMetadata?.candidatesTokenCount || 0;

    if (!text) throw new Error('Gemini returned empty response');

    return { text, tokensIn, tokensOut, model: GEMINI_MODEL };
  }

  // Сюда попадаем только если все прокси перебраны и ни один не сработал
  if (lastError) {
    lastError.isDeterministic = true;
    lastError.isGeoBlock = lastError.isGeoBlock || false;
    throw lastError;
  }
  throw new Error('All Gemini proxies exhausted');
}

module.exports = { callGemini };
