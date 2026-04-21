'use strict';

const axios       = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

// ────────────────────────────────────────────────────────────────────
// MAX_GEMINI_INPUT_LENGTH — верхняя граница суммарной длины
// (systemInstruction + userPrompt) в символах. Ранее было 100 КБ; увеличено
// до 200 КБ с внедрением AKB: сам AKB (systemInstruction) занимает до ~25 КБ,
// плюс Stage 5/6 передают currentHTML до ~10-15 КБ в userPrompt. Лимит
// остаётся защитой от случайной отправки мегабайтного мусора в API.
// ────────────────────────────────────────────────────────────────────
const MAX_GEMINI_INPUT_LENGTH = 200000;

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
// ── Встроенные константы (используются если env-переменные не заданы) ──
const DEFAULT_PROXY = {
  host:  '155.212.59.188',
  port:  '64464',
  user:  '76MkBTXZ',
  pass:  '3ukb66G1',
  proto: 'http',
};

const DEFAULT_GEMINI_API_KEY = 'AIzaSyB7crSRTwPocoY31vordEKmQFvEsgD0tLQ';

function resolveProxyUrl(suffix = '') {
  // 1. Полная строка (с автонормализацией формата)
  const full = process.env[`GEMINI_PROXY_URL${suffix}`] || '';
  if (full) return normalizeProxyUrl(full);

  // 2. Компоненты из env
  const host = process.env[`GEMINI_PROXY_HOST${suffix}`] || '';
  const port = process.env[`GEMINI_PROXY_PORT${suffix}`] || '';
  if (host && port) {
    const user = process.env[`GEMINI_PROXY_USER${suffix}`] || '';
    const pass = process.env[`GEMINI_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`GEMINI_PROXY_PROTO${suffix}`] || 'http';
    if (user && pass) {
      // URL-encode user/pass — спецсимволы (@, :, #, $) ломают URL без кодирования
      return `${proto}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }
    return `${proto}://${host}:${port}`;
  }

  // 3. Системная (только для основного прокси)
  if (!suffix) {
    const sys = process.env.HTTPS_PROXY || process.env.https_proxy || '';
    if (sys) return sys;
  }

  // 4. Встроенный прокси-fallback (только для основного, без суффикса)
  if (!suffix) {
    console.log('[gemini] Env-переменные прокси не заданы — используем встроенный прокси');
    return `${DEFAULT_PROXY.proto}://${encodeURIComponent(DEFAULT_PROXY.user)}:${encodeURIComponent(DEFAULT_PROXY.pass)}@${DEFAULT_PROXY.host}:${DEFAULT_PROXY.port}`;
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

/**
 * Диагностика переменных окружения для прокси (помогает найти проблему).
 */
function logProxyDiagnostics() {
  const suffixes = ['', '_2', '_3', '_4', '_5'];
  const envVars = [];
  for (const sfx of suffixes) {
    const url  = process.env[`GEMINI_PROXY_URL${sfx}`] || '';
    const host = process.env[`GEMINI_PROXY_HOST${sfx}`] || '';
    const port = process.env[`GEMINI_PROXY_PORT${sfx}`] || '';
    const user = process.env[`GEMINI_PROXY_USER${sfx}`] || '';
    const pass = process.env[`GEMINI_PROXY_PASS${sfx}`] || '';
    if (url || host || port || user || pass) {
      envVars.push(`  GEMINI_PROXY_URL${sfx}=${url ? '✓ задан' : '(пусто)'} | HOST${sfx}=${host ? '✓' : '-'} PORT${sfx}=${port ? '✓' : '-'} USER${sfx}=${user ? '✓' : '-'} PASS${sfx}=${pass ? '✓' : '-'}`);
    }
  }
  if (envVars.length > 0) {
    console.log(`[gemini] Переменные окружения прокси:\n${envVars.join('\n')}`);
  } else {
    console.warn('[gemini] ⚠ Ни одна переменная GEMINI_PROXY_* не задана!');
    console.warn('[gemini]   Задайте в .env, например: GEMINI_PROXY_URL=login:password:ip:port');
    console.warn('[gemini]   Или через компоненты: GEMINI_PROXY_HOST, _PORT, _USER, _PASS');
  }
}

/**
 * Стартовый тест прокси — один лёгкий GET-запрос для проверки связности.
 * Не блокирует инициализацию — работает в фоне.
 */
async function testProxyConnectivity() {
  if (PROXY_URLS.length === 0) return;

  const apiKey = process.env.GEMINI_API_KEY || DEFAULT_GEMINI_API_KEY;
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[gemini] ⚠ GEMINI_API_KEY не задан в env — используем встроенный ключ для теста');
  }

  // Лёгкий запрос — список моделей (не тратит токены)
  const testUrl = `${GEMINI_BASE_URL}?key=${apiKey}`;

  for (let i = 0; i < PROXY_URLS.length; i++) {
    const agent = buildProxyAgent(i);
    if (!agent) continue;

    try {
      const resp = await axios.get(testUrl, {
        httpsAgent: agent,
        proxy:      false,
        timeout:    15000,
        validateStatus: null,
      });
      if (resp.status === 200) {
        console.log(`[gemini] ✅ Прокси [${i}] ${safeProxyLog(PROXY_URLS[i])} — работает`);
      } else if (resp.status === 407) {
        console.error(`[gemini] ❌ Прокси [${i}] ${safeProxyLog(PROXY_URLS[i])} — ошибка 407: прокси требует авторизацию. Проверьте логин/пароль в GEMINI_PROXY_URL`);
      } else if (resp.status === 400 && isGeoBlockError(resp.data?.error?.message || '')) {
        console.warn(`[gemini] ⚠ Прокси [${i}] ${safeProxyLog(PROXY_URLS[i])} — гео-блокировка (IP прокси в запрещённом регионе)`);
      } else {
        console.warn(`[gemini] ⚠ Прокси [${i}] ${safeProxyLog(PROXY_URLS[i])} — HTTP ${resp.status}`);
      }
    } catch (err) {
      // Специальная обработка 407 — https-proxy-agent бросает ошибку при CONNECT
      if (err.message && (err.message.includes('407') || err.message.includes('Proxy Authentication Required'))) {
        console.error(`[gemini] ❌ Прокси [${i}] ${safeProxyLog(PROXY_URLS[i])} — ошибка 407: прокси требует авторизацию!`);
        console.error(`[gemini]   Проверьте логин/пароль. Формат: GEMINI_PROXY_URL=login:password:ip:port`);
      } else {
        console.warn(`[gemini] ⚠ Прокси [${i}] ${safeProxyLog(PROXY_URLS[i])} — ошибка: ${err.message}`);
      }
    }
  }
}

// Стартовый лог — показывает, через что пойдут запросы
logProxyDiagnostics();
if (PROXY_URLS.length > 0) {
  console.log(`[gemini] Прокси включён (${PROXY_URLS.length} шт):`);
  PROXY_URLS.forEach((u, i) => console.log(`  [${i}] ${safeProxyLog(u)}`));
  // Фоновый тест — не блокирует запуск
  testProxyConnectivity().catch(err => {
    console.warn(`[gemini] Фоновый тест прокси завершился с ошибкой: ${err.message}`);
  });
} else {
  console.error('[gemini] ═══════════════════════════════════════════════════════════════');
  console.error('[gemini] ❌ КРИТИЧЕСКАЯ ОШИБКА: Прокси НЕ задан!');
  console.error('[gemini]    Все запросы к Gemini API будут заблокированы.');
  console.error('[gemini] ');
  console.error('[gemini]    РЕКОМЕНДУЕМЫЙ СПОСОБ — отдельные компоненты в .env:');
  console.error('[gemini]      GEMINI_PROXY_HOST=155.212.59.188');
  console.error('[gemini]      GEMINI_PROXY_PORT=64464');
  console.error('[gemini]      GEMINI_PROXY_USER=your_login');
  console.error('[gemini]      GEMINI_PROXY_PASS=your_password');
  console.error('[gemini] ');
  console.error('[gemini]    Или полная строка (в кавычках!):');
  console.error('[gemini]      GEMINI_PROXY_URL="http://login:password@ip:port"');
  console.error('[gemini] ');
  console.error('[gemini]    После изменения .env пересоздайте контейнеры:');
  console.error('[gemini]      docker compose down && docker compose up -d --build');
  console.error('[gemini] ');
  console.error('[gemini]    Проверка прокси из контейнера:');
  console.error('[gemini]      docker exec seo_worker node scripts/check-proxy.js');
  console.error('[gemini] ═══════════════════════════════════════════════════════════════');
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
 * @param {string} systemInstruction  — системный промпт (передаётся в нативное
 *                                      поле `systemInstruction.parts`, рядом
 *                                      с обязательным JSON-strict guard)
 * @param {string} userPrompt         — пользовательский промпт
 * @param {object} [options]
 * @param {number} [options.temperature=0.4]
 * @param {number} [options.maxTokens=16384]
 * @param {number} [options.timeoutMs=180000]   — Gemini медленнее, даём 3 мин
 * @param {string} [options.cachedContent]      — имя кэша (`cachedContents/...`).
 *                                                Если задан, `systemInstruction`
 *                                                НЕ отправляется (он уже в кэше).
 *
 * @returns {Promise<{
 *   text:       string,
 *   tokensIn:   number,
 *   tokensOut:  number,
 *   model:      string,
 *   cacheMiss?: boolean,   // true если cachedContent был запрошен, но кэш истёк
 * }>}
 */
async function callGemini(systemInstruction, userPrompt, options = {}) {
  // Валидация входных данных
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  // Лимит длины повышен: AKB как нативный systemInstruction может быть до ~25 КБ.
  if ((systemInstruction + userPrompt).length > MAX_GEMINI_INPUT_LENGTH) {
    throw new Error('Input text too long');
  }

  const {
    temperature = 0.4,
    maxTokens   = 16384,
    timeoutMs   = 180000,
    cachedContent = null,
  } = options;

  // Проверка параметров
  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  if (timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid timeout');

  // API ключ Gemini — из переменной окружения или встроенный fallback
  const apiKey = process.env.GEMINI_API_KEY || DEFAULT_GEMINI_API_KEY;
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[gemini] ⚠ GEMINI_API_KEY не задан в env — используем встроенный ключ');
  }

  const endpoint = `${GEMINI_BASE_URL}/${GEMINI_MODEL}:generateContent?key=${apiKey}`;

  // ── JSON-strict guard (всегда в systemInstruction) ────────────────
  const JSON_STRICT_GUARD =
    'You are a strict REST API. Output ONLY valid JSON. Do not wrap in Markdown. ' +
    'Never use trailing commas. CRITICAL RULES: ' +
    '1) NEVER use double quotes inside string values (use single quotes \'\' instead). ' +
    '2) Always enclose JSON keys in double quotes. ' +
    '3) NEVER use unescaped newlines inside string values.';

  // userPrompt всегда уходит в `contents`. systemInstruction идёт в нативное поле.
  const payload = {
    contents: [{
      parts: [{ text: userPrompt }],
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

  if (cachedContent) {
    // При cache-hit `systemInstruction` НЕ дублируем — он уже в кэше.
    // Поле верхнего уровня — формат Gemini API.
    payload.cachedContent = cachedContent;
  } else {
    // Нативное поле systemInstruction. Склеиваем JSON-guard и пользовательский
    // системный промпт (AKB / большую инструкцию). Используем отдельные части,
    // чтобы порядок был детерминированным и стабильным для implicit cache.
    const sysParts = [{ text: JSON_STRICT_GUARD }];
    if (systemInstruction && systemInstruction.trim()) {
      sysParts.push({ text: systemInstruction });
    }
    payload.systemInstruction = { parts: sysParts };
  }

  // ── Прокси обязателен — без прокси запросы запрещены ──
  if (PROXY_URLS.length === 0) {
    throw new Error(
      'GEMINI_PROXY не задан! Запросы к Gemini API без прокси запрещены.\n' +
      'Задайте в .env (рекомендуется — компонентами):\n' +
      '  GEMINI_PROXY_HOST=ip\n' +
      '  GEMINI_PROXY_PORT=port\n' +
      '  GEMINI_PROXY_USER=login\n' +
      '  GEMINI_PROXY_PASS=password\n' +
      'Или полной строкой: GEMINI_PROXY_URL="http://login:password@ip:port"\n' +
      'Затем: docker compose down && docker compose up -d --build\n' +
      'Проверка: docker exec seo_worker node scripts/check-proxy.js'
    );
  }

  // ── Попытка с текущим активным прокси, при гео-ошибке — переключаемся ──
  const totalAttempts = PROXY_URLS.length;
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const proxyIdx = (activeProxyIdx + attempt) % PROXY_URLS.length;
    const proxyAgent = buildProxyAgent(proxyIdx);

    // Логируем через какой прокси идёт запрос (для диагностики)
    if (proxyAgent) {
      console.log(`[gemini] Запрос через прокси [${proxyIdx}] ${safeProxyLog(PROXY_URLS[proxyIdx])}`);
    } else {
      // Прокси задан, но agent не создался (невалидный URL) — НЕ отправляем напрямую!
      console.warn(`[gemini] ⚠ Прокси [${proxyIdx}] не удалось создать — пропускаем`);
      lastError = new Error(`Gemini proxy [${proxyIdx}] agent creation failed`);
      if (attempt < totalAttempts - 1) continue;
      throw lastError;
    }

    const axiosCfg = {
      timeout:        timeoutMs,
      headers:        { 'Content-Type': 'application/json' },
      validateStatus: null,
      httpsAgent:     proxyAgent,
      proxy:          false,
    };

    let response;
    try {
      response = await axios.post(endpoint, payload, axiosCfg);
    } catch (networkErr) {
      // Сетевая ошибка прокси (timeout, ECONNREFUSED и т.д.)
      // Переключаемся на следующий прокси
      const proxyLabel = `прокси [${proxyIdx}] ${safeProxyLog(PROXY_URLS[proxyIdx])}`;

      // Специальная обработка 407 — прокси требует авторизацию
      const is407 = networkErr.message && (networkErr.message.includes('407') || networkErr.message.includes('Proxy Authentication Required'));
      if (is407) {
        console.error(`[gemini] ❌ Прокси [${proxyIdx}] — ошибка 407: прокси требует авторизацию!`);
        console.error(`[gemini]   Проверьте логин/пароль в GEMINI_PROXY_URL. Формат: login:password:ip:port`);
        const authErr = new Error(`Proxy authentication failed (407) for ${proxyLabel}. Check GEMINI_PROXY_URL credentials.`);
        authErr.isProxyAuthError = true;
        authErr.isDeterministic = true;
        lastError = authErr;
      } else {
        console.warn(`[gemini] Сетевая ошибка через ${proxyLabel}: ${networkErr.message}`);
        lastError = networkErr;
      }

      if (attempt < totalAttempts - 1) {
        console.log(`[gemini] Переключаемся на следующий прокси...`);
        continue;
      }
      throw lastError;
    }

    if (response.status === 407) {
      // Прокси вернул 407 как HTTP-ответ (а не как ошибку CONNECT)
      const proxyLabel = safeProxyLog(PROXY_URLS[proxyIdx]);
      console.error(`[gemini] ❌ Прокси [${proxyIdx}] — HTTP 407: прокси требует авторизацию!`);
      console.error(`[gemini]   Проверьте логин/пароль в GEMINI_PROXY_URL. Формат: login:password:ip:port`);
      const authErr = new Error(`Proxy authentication failed (407) for ${proxyLabel}. Check GEMINI_PROXY_URL credentials.`);
      authErr.isProxyAuthError = true;
      authErr.isDeterministic = true;
      lastError = authErr;
      if (attempt < totalAttempts - 1) {
        console.log(`[gemini] Переключаемся на следующий прокси...`);
        continue;
      }
      throw authErr;
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
      const proxyInfo = ` [proxy ${proxyIdx}]`;
      const fullMsg = `Gemini API error ${response.status}: ${msg} — ${detail}${proxyInfo}`;

      // ── Гео-блокировка → переключаем прокси ──────────────────────
      if (isGeoBlockError(detail) && attempt < totalAttempts - 1) {
        console.warn(`[gemini] Гео-блокировка через ${safeProxyLog(PROXY_URLS[proxyIdx])}. Переключаемся на следующий прокси...`);
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
      // ── Cache miss / expired (404 + cachedContent в payload) ─────
      // Маркируем как детерминированную ошибку с флагом isCacheMiss,
      // чтобы вызывающая сторона могла очистить cacheName и повторить
      // запрос без кэша.
      if (cachedContent && (response.status === 404 ||
          /cachedContent|cached.?content/i.test(detail))) {
        err.isCacheMiss = true;
        err.isDeterministic = true;
      }
      throw err;
    }

    // ── Успех! Запоминаем работающий прокси ──────────────────────────
    if (proxyIdx !== activeProxyIdx) {
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

module.exports = { callGemini, createCachedContent, deleteCachedContent };

// ────────────────────────────────────────────────────────────────────
// Gemini Context Caching API (`cachedContents`)
//
// Документация: https://ai.google.dev/gemini-api/docs/caching
// Скидка ~75 % на cached input tokens — критично для нашего кейса
// «один AKB на статью → 6-10 вызовов Stage 3/5/6».
// ────────────────────────────────────────────────────────────────────

/**
 * createCachedContent — создаёт в Gemini API кэшированный контекст
 * (нашу AKB как `systemInstruction`).
 *
 * @param {object} args
 * @param {string} args.systemInstruction — текст AKB (пойдёт в кэш).
 * @param {number} [args.ttlSeconds=900]  — TTL кэша (15 мин по умолчанию;
 *                                          обычно перекрывает одну статью).
 * @param {number} [args.timeoutMs=60000]
 * @returns {Promise<{ name: string, model: string, ttlSeconds: number }>}
 *          name — `cachedContents/abc123…`, передаётся в callGemini({cachedContent}).
 */
async function createCachedContent({ systemInstruction, ttlSeconds = 900, timeoutMs = 60000 }) {
  if (!systemInstruction || typeof systemInstruction !== 'string') {
    throw new Error('createCachedContent: systemInstruction must be a non-empty string');
  }
  if (PROXY_URLS.length === 0) {
    throw new Error('createCachedContent: GEMINI_PROXY не задан');
  }

  const apiKey = process.env.GEMINI_API_KEY || DEFAULT_GEMINI_API_KEY;

  // Endpoint для cachedContents: /v1beta/cachedContents
  // GEMINI_BASE_URL заканчивается на /v1beta/models — отрезаем «/models»
  const baseRoot = GEMINI_BASE_URL.replace(/\/models$/, '');
  const endpoint = `${baseRoot}/cachedContents?key=${apiKey}`;

  const JSON_STRICT_GUARD =
    'You are a strict REST API. Output ONLY valid JSON. Do not wrap in Markdown. ' +
    'Never use trailing commas. CRITICAL RULES: ' +
    '1) NEVER use double quotes inside string values (use single quotes \'\' instead). ' +
    '2) Always enclose JSON keys in double quotes. ' +
    '3) NEVER use unescaped newlines inside string values.';

  const payload = {
    model: `models/${GEMINI_MODEL}`,
    systemInstruction: {
      parts: [
        { text: JSON_STRICT_GUARD },
        { text: systemInstruction },
      ],
    },
    ttl: `${Math.max(60, Math.floor(ttlSeconds))}s`,
  };

  const proxyAgent = buildProxyAgent(activeProxyIdx) || buildProxyAgent(0);
  if (!proxyAgent) throw new Error('createCachedContent: proxy agent unavailable');

  const response = await axios.post(endpoint, payload, {
    timeout:        timeoutMs,
    headers:        { 'Content-Type': 'application/json' },
    validateStatus: null,
    httpsAgent:     proxyAgent,
    proxy:          false,
  });

  if (response.status !== 200) {
    const detail = response.data?.error?.message || JSON.stringify(response.data).slice(0, 300);
    const err = new Error(`Gemini cachedContents create failed (HTTP ${response.status}): ${detail}`);
    err.isDeterministic = true;
    throw err;
  }

  const name = response.data?.name;
  if (!name) throw new Error('Gemini cachedContents: response missing `name`');

  return {
    name,
    model:      GEMINI_MODEL,
    ttlSeconds: Math.max(60, Math.floor(ttlSeconds)),
  };
}

/**
 * deleteCachedContent — удаляет кэш в Gemini API.
 * Безопасно идемпотентен: 404 не считается ошибкой.
 *
 * @param {string} cacheName — `cachedContents/abc123…`
 * @param {number} [timeoutMs=20000]
 * @returns {Promise<boolean>} — true если удалено / уже не было; false при иной ошибке.
 */
async function deleteCachedContent(cacheName, timeoutMs = 20000) {
  if (!cacheName || typeof cacheName !== 'string') return false;
  if (PROXY_URLS.length === 0) return false;

  const apiKey = process.env.GEMINI_API_KEY || DEFAULT_GEMINI_API_KEY;
  const baseRoot = GEMINI_BASE_URL.replace(/\/models$/, '');
  const endpoint = `${baseRoot}/${cacheName}?key=${apiKey}`;

  const proxyAgent = buildProxyAgent(activeProxyIdx) || buildProxyAgent(0);
  if (!proxyAgent) return false;

  try {
    const response = await axios.delete(endpoint, {
      timeout:        timeoutMs,
      validateStatus: null,
      httpsAgent:     proxyAgent,
      proxy:          false,
    });
    if (response.status === 200 || response.status === 204 || response.status === 404) return true;
    console.warn(`[gemini] deleteCachedContent: HTTP ${response.status} — ${JSON.stringify(response.data).slice(0, 200)}`);
    return false;
  } catch (e) {
    console.warn(`[gemini] deleteCachedContent error: ${e.message}`);
    return false;
  }
}
