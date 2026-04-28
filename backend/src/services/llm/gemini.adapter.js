'use strict';

const axios       = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

// Дефолтный таймаут одного HTTP-запроса к Gemini.
// gemini-3.1-pro-preview — reasoning-модель: при maxTokens=16384 и больших
// IAKB / writer-промптах (~50 КБ ввода) ответ регулярно занимает 3–5 минут.
// 180 с уходили в timeout у InfoArticle Stage 3 — поэтому подняли default до
// 300 с и сделали значение настраиваемым через env. Верхний предел в
// validateOptions поднят до 600 с (см. ниже).
const DEFAULT_GEMINI_TIMEOUT_MS = (() => {
  const raw = Number(process.env.GEMINI_TIMEOUT_MS);
  return Number.isFinite(raw) && raw >= 1000 && raw <= 600000 ? raw : 300000;
})();

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
// Прокси резолвится только из env (GEMINI_PROXY_*, HTTPS_PROXY).
// Хардкоженный fallback УБРАН (point 9.1 безопасности): захардкоженные
// учётки прокси нельзя ротировать без релиза, утекают в публичный репо
// и тривиально сканятся. Если ни один env-прокси не задан — запросы
// идут напрямую (или падают с network error в локациях, где Gemini API
// недоступен — это явный сигнал админу настроить .env).

// Gemini API key загружается ИСКЛЮЧИТЕЛЬНО из process.env.GEMINI_API_KEY
// (см. .env / docker-compose env_file). Хардкод запрещён — Google Secret Scanning
// автоматически отзывает ключи, найденные в публичных репозиториях.
function requireGeminiApiKey() {
  const k = (process.env.GEMINI_API_KEY || '').trim();
  if (!k) {
    throw new Error(
      'GEMINI_API_KEY не задан. Добавьте его в .env (см. .env.example) — ' +
      'ключ нужен для генерации SEO-контента, AI-редактора и мета-тегов.'
    );
  }
  return k;
}

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

  // Если ключ не задан — пропускаем проверку прокси (сам сервис всё равно
  // упадёт с понятной ошибкой при первой генерации).
  if (!(process.env.GEMINI_API_KEY || '').trim()) {
    console.warn('[gemini] ⚠ GEMINI_API_KEY не задан — пропускаем тест прокси');
    return;
  }
  const apiKey = requireGeminiApiKey();

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
 * @param {number} [options.timeoutMs=DEFAULT_GEMINI_TIMEOUT_MS] — Gemini медленнее
 *                                              (reasoning-модель + 16K токенов
 *                                              ответа). Default 300 с,
 *                                              переопределяется GEMINI_TIMEOUT_MS.
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
    timeoutMs   = DEFAULT_GEMINI_TIMEOUT_MS,
    cachedContent = null,
    // plainText=true → НЕ навешиваем JSON_STRICT_GUARD и НЕ форсим
    // responseMimeType=application/json. Используется фолбэком streamGenerate(),
    // когда AI-Copilot редактору нужен HTML/Markdown вместо JSON.
    plainText  = false,
    // model — позволяет переопределить GEMINI_MODEL (например, EDITOR_COPILOT_MODEL).
    model      = GEMINI_MODEL,
  } = options;

  // Проверка параметров
  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  if (timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Invalid timeout');

  // API ключ Gemini — только из переменной окружения (без хардкода)
  const apiKey = requireGeminiApiKey();

  const endpoint = `${GEMINI_BASE_URL}/${model}:generateContent?key=${apiKey}`;

  // ── JSON-strict guard (всегда в systemInstruction) ────────────────
  const JSON_STRICT_GUARD =
    'You are a strict REST API. Output ONLY valid JSON. Do not wrap in Markdown. ' +
    'Never use trailing commas. CRITICAL RULES: ' +
    '1) NEVER use double quotes inside string values (use single quotes \'\' instead). ' +
    '2) Always enclose JSON keys in double quotes. ' +
    '3) NEVER use unescaped newlines inside string values.';

  // userPrompt всегда уходит в `contents`. systemInstruction идёт в нативное поле.
  const generationConfig = {
    temperature,
    maxOutputTokens:  maxTokens,
  };
  // Для не-plainText вызовов (основной пайплайн / meta-tags) форсим JSON-выход.
  // plainText=true (фолбэк AI-Copilot редактора) оставляет свободный текст/HTML.
  if (!plainText) {
    generationConfig.responseMimeType = 'application/json';
  }

  const payload = {
    contents: [{
      parts: [{ text: userPrompt }],
    }],
    generationConfig,
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
    // Нативное поле systemInstruction. Для JSON-режима склеиваем JSON-guard и
    // пользовательский системный промпт; для plainText — только пользовательский.
    const sysParts = [];
    if (!plainText) sysParts.push({ text: JSON_STRICT_GUARD });
    if (systemInstruction && systemInstruction.trim()) {
      sysParts.push({ text: systemInstruction });
    }
    if (sysParts.length) {
      payload.systemInstruction = { parts: sysParts };
    }
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
    // ── Извлечение текста: агрегируем ВСЕ part'ы кандидата ────────────
    // Gemini может разбить ответ на несколько `parts` (особенно длинный
    // JSON), а thinking-модели иногда вставляют служебный part с флагом
    // `thought:true` без текста. Берём только текстовые части и склеиваем,
    // иначе `parts[0].text` может оказаться пустым/частичным → "не-JSON".
    const candidate = data?.candidates?.[0];
    const partsArr  = candidate?.content?.parts;
    let text = '';
    if (Array.isArray(partsArr)) {
      for (const p of partsArr) {
        if (p && p.thought) continue;
        if (typeof p?.text === 'string') text += p.text;
      }
    }
    const finishReason = candidate?.finishReason || '';
    const tokensIn  = data?.usageMetadata?.promptTokenCount     || 0;
    const tokensOut = data?.usageMetadata?.candidatesTokenCount || 0;

    if (!text) {
      // Различаем «обрезано лимитом» / «заблокировано» / «пусто» — это
      // помогает вызывающей стороне (meta-tags, stage*) показать осмысленную
      // ошибку вместо абстрактного "Gemini вернул не-JSON ответ".
      if (finishReason === 'MAX_TOKENS') {
        const err = new Error(
          `Gemini truncated by MAX_TOKENS (output=${tokensOut} ток.). ` +
          `Увеличьте maxTokens или сократите промпт.`
        );
        err.isDeterministic = true;
        err.finishReason = finishReason;
        throw err;
      }
      if (finishReason === 'SAFETY' || finishReason === 'RECITATION' || finishReason === 'PROHIBITED_CONTENT') {
        const err = new Error(`Gemini blocked response (finishReason=${finishReason})`);
        err.isDeterministic = true;
        err.finishReason = finishReason;
        throw err;
      }
      throw new Error(`Gemini returned empty response (finishReason=${finishReason || 'UNKNOWN'})`);
    }

    // Если ответ был обрезан лимитом — приклеиваем понятное предупреждение
    // в meta, чтобы вызывающая сторона могла среагировать (autoCloseJSON
    // и т.п.). Сам текст возвращаем как есть.
    return { text, tokensIn, tokensOut, model, finishReason };
  }

  // Сюда попадаем только если все прокси перебраны и ни один не сработал
  if (lastError) {
    lastError.isDeterministic = true;
    lastError.isGeoBlock = lastError.isGeoBlock || false;
    throw lastError;
  }
  throw new Error('All Gemini proxies exhausted');
}

/**
 * streamGenerate — потоковая (SSE) генерация Gemini для AI-Copilot редактора.
 *
 * В отличие от callGemini() этот вызов:
 *   - НЕ форсит responseMimeType=application/json (нужен plain text/HTML);
 *   - использует endpoint `:streamGenerateContent?alt=sse` с потоковым ответом;
 *   - вызывает onChunk(deltaText) на каждом текстовом фрагменте;
 *   - возвращает агрегированный текст + точные usage-метрики из Gemini.
 *
 * Если поток-ориентированный режим вернул пустой ответ (типичная причина —
 * буферизирующий промежуточный прокси или временный сбой `alt=sse` у Gemini)
 * и при этом нет жёсткого блока (SAFETY/RECITATION/PROHIBITED/blockReason),
 * функция автоматически повторяет запрос обычным `callGemini({plainText:true})`
 * и эмитит результат одним «фиктивным» чанком — фронт всё равно увидит
 * SSE-события от нашего бэкенда, а пользователь получит непустой текст.
 *
 * @param {string}   systemInstruction
 * @param {string}   userPrompt
 * @param {object}   options
 * @param {function} options.onChunk     (deltaText, meta?) => void
 * @param {function} [options.shouldAbort] () => boolean — раз в чанк проверяется
 * @param {number}   [options.temperature=0.6]
 * @param {number}   [options.maxTokens=8192]
 * @param {number}   [options.timeoutMs=180000]
 * @param {string}   [options.model]      — переопределяет GEMINI_MODEL
 * @returns {Promise<{ text, tokensIn, tokensOut, model, aborted }>}
 */
async function streamGenerate(systemInstruction, userPrompt, options = {}) {
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('streamGenerate: systemInstruction and userPrompt must be strings');
  }
  if ((systemInstruction + userPrompt).length > MAX_GEMINI_INPUT_LENGTH) {
    throw new Error('streamGenerate: input text too long');
  }

  const {
    onChunk     = () => {},
    shouldAbort = () => false,
    temperature = 0.6,
    maxTokens   = 8192,
    timeoutMs   = 180000,
    model       = GEMINI_MODEL,
  } = options;

  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  if (timeoutMs < 1000 || timeoutMs > 600000) throw new Error('Invalid timeout');

  if (PROXY_URLS.length === 0) {
    throw new Error('streamGenerate: GEMINI_PROXY не задан');
  }

  const apiKey = requireGeminiApiKey();
  const endpoint = `${GEMINI_BASE_URL}/${model}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const payload = {
    contents: [{ parts: [{ text: userPrompt }] }],
    generationConfig: {
      temperature,
      maxOutputTokens: maxTokens,
      // НЕ ставим responseMimeType: для редактора нужен HTML/Markdown текст
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };
  if (systemInstruction && systemInstruction.trim()) {
    payload.systemInstruction = { parts: [{ text: systemInstruction }] };
  }

  const totalAttempts = PROXY_URLS.length;
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const proxyIdx   = (activeProxyIdx + attempt) % PROXY_URLS.length;
    const proxyAgent = buildProxyAgent(proxyIdx);
    if (!proxyAgent) {
      lastError = new Error(`Gemini proxy [${proxyIdx}] agent creation failed`);
      if (attempt < totalAttempts - 1) continue;
      throw lastError;
    }

    let response;
    try {
      response = await axios.post(endpoint, payload, {
        timeout:        timeoutMs,
        headers:        { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
        validateStatus: null,
        httpsAgent:     proxyAgent,
        proxy:          false,
        responseType:   'stream',
      });
    } catch (networkErr) {
      console.warn(`[gemini-stream] network error proxy [${proxyIdx}]: ${networkErr.message}`);
      lastError = networkErr;
      if (attempt < totalAttempts - 1) continue;
      throw lastError;
    }

    if (response.status !== 200) {
      // При не-200 тело тоже Stream — собираем буфер для диагностики.
      const buf = await readStreamToString(response.data, 4000);
      let detail = buf.slice(0, 600);
      try { detail = JSON.parse(buf)?.error?.message || detail; } catch (_) {}
      const err = new Error(`Gemini stream API error ${response.status}: ${detail} [proxy ${proxyIdx}]`);
      if (response.status === 429 || response.status === 503) {
        err.status = response.status;
        throw err;
      }
      if (isGeoBlockError(detail) && attempt < totalAttempts - 1) {
        console.warn(`[gemini-stream] geo-block proxy [${proxyIdx}], switching...`);
        lastError = err; lastError.isGeoBlock = true; lastError.isDeterministic = true;
        continue;
      }
      err.isDeterministic = true;
      if (isGeoBlockError(detail)) err.isGeoBlock = true;
      throw err;
    }

    // ── Успешный поток ──
    if (proxyIdx !== activeProxyIdx) {
      console.log(`[gemini-stream] proxy [${proxyIdx}] works — pinning as active`);
      activeProxyIdx = proxyIdx;
    }

    const result = await consumeSseStream(response.data, { onChunk, shouldAbort });

    // ── Фолбэк на не-потоковый callGemini ──────────────────────────────
    // Если SSE-канал закрылся без единого текстового кадра (типичная причина —
    // буферизирующий промежуточный прокси, кратковременный сбой alt=sse у
    // Gemini, либо пустой ответ модели при не-жёстком finishReason), повторяем
    // запрос обычным generateContent. Жёсткие блокировки (SAFETY / RECITATION /
    // PROHIBITED_CONTENT / promptFeedback.blockReason / safetyRatings.blocked)
    // фолбэком НЕ маскируем — пользователь должен увидеть реальную причину.
    const isHardBlock = result.safetyBlocked
      || !!result.blockReason
      || result.finishReason === 'SAFETY'
      || result.finishReason === 'RECITATION'
      || result.finishReason === 'PROHIBITED_CONTENT';
    const isEmpty = !result.aborted && (!result.text || !result.text.trim());

    if (isEmpty && !isHardBlock) {
      console.warn(
        `[gemini-stream] empty SSE response (finishReason=${result.finishReason || 'NONE'}, ` +
        `tokensIn=${result.tokensIn || 0}). Falling back to non-streaming generateContent.`
      );
      try {
        const fb = await callGemini(systemInstruction, userPrompt, {
          temperature,
          maxTokens,
          // callGemini ограничивает timeoutMs ≤ 300000 — клампим, чтобы не
          // получить «Invalid timeout» при больших значениях у потока.
          timeoutMs: Math.min(timeoutMs, 300000),
          model,
          plainText: true,
        });
        if (fb && fb.text) {
          // Эмулируем потоковый чанк, чтобы UI редактора получил текст одним
          // куском — состояние редактора (streamingText / partialText в БД)
          // обновится так же, как при обычном стриме.
          try { onChunk(fb.text); } catch (e) {
            console.warn('[gemini-stream] onChunk (fallback) threw:', e.message);
          }
          return {
            text:          fb.text,
            tokensIn:      fb.tokensIn  || 0,
            tokensOut:     fb.tokensOut || 0,
            aborted:       false,
            finishReason:  fb.finishReason || result.finishReason || null,
            blockReason:   null,
            safetyBlocked: false,
            model,
            fallbackUsed:  true,
          };
        }
      } catch (fbErr) {
        console.warn(`[gemini-stream] non-streaming fallback failed: ${fbErr.message}`);
        // Прокидываем ошибку фолбэка наружу с понятным контекстом —
        // у неё обычно есть осмысленный finishReason / detail.
        const wrap = new Error(
          `Gemini empty SSE response and fallback failed: ${fbErr.message}`
        );
        wrap.isDeterministic = true;
        if (fbErr.finishReason) wrap.finishReason = fbErr.finishReason;
        throw wrap;
      }
    }

    return { ...result, model };
  }

  if (lastError) throw lastError;
  throw new Error('All Gemini proxies exhausted (stream)');
}

/**
 * consumeSseStream — потребляет axios-stream Gemini :streamGenerateContent?alt=sse,
 * парсит SSE-кадры формата `data: {...}\n\n` и:
 *   - вызывает onChunk(text) на каждом text-фрагменте,
 *   - аккумулирует usageMetadata из последнего кадра.
 */
function consumeSseStream(stream, { onChunk, shouldAbort }) {
  return new Promise((resolve, reject) => {
    let buffer       = '';
    let aggregate    = '';
    let tokensIn     = 0;
    let tokensOut    = 0;
    let aborted      = false;
    let finishReason = null;
    let blockReason  = null;
    let safetyBlocked = false;

    const flushFrame = (frame) => {
      // Каждый SSE-кадр — JSON-объект GenerateContentResponse
      let json;
      try { json = JSON.parse(frame); } catch (_) { return; }
      const cand = json?.candidates?.[0];
      const parts = cand?.content?.parts;
      if (Array.isArray(parts)) {
        for (const p of parts) {
          // thinking-модели могут вставлять служебные thought-части —
          // пропускаем их, чтобы не светить «мысли» в UI редактора.
          if (p && p.thought) continue;
          if (typeof p?.text === 'string' && p.text.length) {
            aggregate += p.text;
            try { onChunk(p.text); } catch (e) {
              console.warn('[gemini-stream] onChunk threw:', e.message);
            }
          }
        }
      }
      // Запоминаем последний finishReason — нужен для диагностики пустых ответов.
      if (cand && typeof cand.finishReason === 'string' && cand.finishReason) {
        finishReason = cand.finishReason;
      }
      // safetyRatings на уровне кандидата с blocked=true — тоже признак блокировки.
      if (Array.isArray(cand?.safetyRatings)) {
        for (const r of cand.safetyRatings) {
          if (r && r.blocked === true) { safetyBlocked = true; break; }
        }
      }
      // promptFeedback.blockReason — модель отказалась обрабатывать сам промпт.
      const pf = json?.promptFeedback;
      if (pf && typeof pf.blockReason === 'string' && pf.blockReason) {
        blockReason = pf.blockReason;
      }
      const usage = json?.usageMetadata;
      if (usage) {
        if (typeof usage.promptTokenCount === 'number')      tokensIn  = usage.promptTokenCount;
        if (typeof usage.candidatesTokenCount === 'number')  tokensOut = usage.candidatesTokenCount;
      }
    };

    const onData = (chunk) => {
      if (aborted) return;
      if (shouldAbort && shouldAbort()) {
        aborted = true;
        try { stream.destroy(); } catch (_) {}
        return;
      }
      buffer += chunk.toString('utf8');
      // SSE-кадры разделяются \n\n. Между data:-строками может быть несколько data:-полей.
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines = raw
          .split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim());
        if (!dataLines.length) continue;
        const frame = dataLines.join('');
        if (frame === '[DONE]' || frame === '') continue;
        flushFrame(frame);
      }
    };

    stream.on('data', onData);
    stream.on('end', () => {
      // Хвост — попробуем распарсить остаток
      if (buffer.trim()) {
        const dataLines = buffer
          .split('\n')
          .filter(l => l.startsWith('data:'))
          .map(l => l.slice(5).trim());
        if (dataLines.length) {
          const frame = dataLines.join('');
          if (frame && frame !== '[DONE]') flushFrame(frame);
        }
      }
      resolve({ text: aggregate, tokensIn, tokensOut, aborted, finishReason, blockReason, safetyBlocked });
    });
    stream.on('error', (e) => reject(e));
  });
}

function readStreamToString(stream, maxBytes = 4000) {
  return new Promise((resolve) => {
    let buf = '';
    let stopped = false;
    stream.on('data', (chunk) => {
      if (stopped) return;
      buf += chunk.toString('utf8');
      if (buf.length >= maxBytes) {
        stopped = true;
        try { stream.destroy(); } catch (_) {}
        resolve(buf);
      }
    });
    stream.on('end',   () => resolve(buf));
    stream.on('error', () => resolve(buf));
  });
}

module.exports = { callGemini, streamGenerate, createCachedContent, deleteCachedContent };

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

  const apiKey = requireGeminiApiKey();

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

  const apiKey = requireGeminiApiKey();
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
