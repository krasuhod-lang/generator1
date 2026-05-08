'use strict';

/**
 * DashScope (Alibaba Model Studio) — прямой OpenAI-совместимый адаптер.
 *
 * Используется вкладкой «Сформировать JSON» (см. backend/src/routes/acfJson.routes.js):
 * заменяет прежнего посредника AITunnel прямым вызовом
 * https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions.
 *
 * Контракт возврата сделан совместимым с прежним AITunnel-прокси
 * (frontend ожидает `{ choice, usage }`):
 *   {
 *     choice: { message: { content }, finish_reason, ... },
 *     usage:  { prompt_tokens, completion_tokens, total_tokens } | null,
 *   }
 *
 * Безопасность ключа:
 *   - DASHSCOPE_API_KEY читается ИСКЛЮЧИТЕЛЬНО из process.env.
 *   - Хардкод/обфускация запрещены (см. requireDashscopeApiKey ниже и аналогичный
 *     паттерн в gemini.adapter.js → requireGeminiApiKey).
 *   - Заголовок Authorization и сам ключ НИКОГДА не попадают в логи —
 *     ни в console.log, ни в текст ошибки. См. _sanitizeAxiosError.
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { calcCost } = require('../metrics/priceCalculator');

// ── Конфигурация ─────────────────────────────────────────────────────────
// Базовый URL OpenAI-совместимого режима DashScope (международный регион).
// Переопределяется через DASHSCOPE_BASE_URL, если нужен китайский регион
// (https://dashscope.aliyuncs.com/compatible-mode/v1) или corporate proxy.
const DASHSCOPE_BASE_URL = (
  process.env.DASHSCOPE_BASE_URL
  || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
).trim().replace(/\/+$/, '');

// Модель по умолчанию — qwen3.6-plus (deep-thinking-capable).
// `enable_thinking: false` ниже гарантирует синхронный (non-stream) ответ
// со стандартным `message.content`, как и было у AITunnel/Qwen3.5.
const DASHSCOPE_MODEL_DEFAULT = (process.env.DASHSCOPE_MODEL || 'qwen3.6-plus').trim();

// Таймаут запроса (мс). Подобран строго меньше фронтового axios-таймаута
// (см. frontend/src/views/AcfJsonPage.vue), чтобы при медленном ответе
// сервер успел отдать осмысленное 502, а не получить гонку с фронтом.
const DEFAULT_TIMEOUT_MS = 240000;

// ── API-ключ: ТОЛЬКО из окружения, без фолбэков ──────────────────────────
function requireDashscopeApiKey() {
  const k = (process.env.DASHSCOPE_API_KEY || '').trim();
  if (!k) {
    throw new Error(
      'DASHSCOPE_API_KEY не задан. Добавьте его в .env (см. .env.example) — '
      + 'ключ нужен для функционала «Сформировать JSON» (Alibaba Model Studio / Qwen).'
    );
  }
  return k;
}

// ── Прокси (опционально, ТОЛЬКО собственные переменные) ─────────────────
// DashScope/Qwen намеренно НЕ наследует общие прокси других LLM
// (`LLM_PROXY_*`, `HTTPS_PROXY`, `GEMINI_PROXY_*`, `XAI_PROXY_*`),
// чтобы вкладка «Сформировать JSON» оставалась полностью независимой:
//   - intl-endpoint `dashscope-intl.aliyuncs.com` обычно доступен напрямую;
//   - проблемы шарингового прокси (TLS-таймауты, обрыв сокета,
//     413 Payload Too Large) не должны блокировать Qwen, если они
//     возникают у Gemini/Grok.
// Если в редкой ситуации требуется именно для DashScope маршрутизировать
// трафик через прокси — задайте ЯВНО `DASHSCOPE_PROXY_URL`
// (или связку `DASHSCOPE_PROXY_HOST`+`DASHSCOPE_PROXY_PORT`).
// Никакого фолбэка на общие переменные больше нет — это сознательное
// архитектурное решение, не баг.
function _normalizeProxyUrl(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(s)) return s;
  return `http://${s}`;
}

function _resolveProxyUrl() {
  // Только явные DashScope-переменные. Никаких LLM_PROXY_* / HTTPS_PROXY /
  // GEMINI_PROXY_* — Qwen работает напрямую, чтобы не зависеть от
  // прокси других провайдеров (см. комментарий выше).
  const dsFull = process.env.DASHSCOPE_PROXY_URL || '';
  if (dsFull) return _normalizeProxyUrl(dsFull);
  const dsHost = process.env.DASHSCOPE_PROXY_HOST || '';
  const dsPort = process.env.DASHSCOPE_PROXY_PORT || '';
  if (dsHost && dsPort) {
    const u = process.env.DASHSCOPE_PROXY_USER || '';
    const p = process.env.DASHSCOPE_PROXY_PASS || '';
    const proto = process.env.DASHSCOPE_PROXY_PROTO || 'http';
    if (u && p) return `${proto}://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${dsHost}:${dsPort}`;
    return `${proto}://${dsHost}:${dsPort}`;
  }
  return '';
}

const PROXY_URL = _resolveProxyUrl();
const PROXY_AGENT = (() => {
  if (!PROXY_URL) return undefined;
  try { return new HttpsProxyAgent(PROXY_URL); }
  catch (e) {
    console.warn('[dashscope] Неверный прокси, игнорируем:', e.message);
    return undefined;
  }
})();

function _safeProxyLog(url) {
  if (!url) return '(none)';
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:([^:@/]+)@/, ':***@');
  }
}

if (PROXY_URL) {
  console.log(`[dashscope] Прокси настроен: ${_safeProxyLog(PROXY_URL)}`);
}

// ── Маскирование ключа в логах/ошибках ──────────────────────────────────
const REDACTED = '***REDACTED***';

/**
 * Удаляет любые следы API-ключа из текста ошибки axios (URL, заголовки, тело).
 * Гарантирует, что ни Authorization-заголовок, ни сам Bearer-токен,
 * ни голый «sk-…» не попадут наружу.
 *
 * ВАЖНО: функция СПЕЦИАЛЬНО не принимает apiKey в качестве аргумента —
 * чтобы статический анализ (CodeQL js/clear-text-logging) видел, что
 * никакая дорожка от секрета к console.* через эту функцию не идёт.
 * Редакция выполняется регулярками по известным шаблонам DashScope-ключа
 * (`sk-…` ≥16 символов) и заголовку `Authorization: Bearer …`.
 */
function _sanitizeAxiosError(err) {
  const stripKey = (val) => {
    if (typeof val !== 'string') return val;
    return val
      // DashScope/OpenAI-style ключ: «sk-XXXXXXXXXXXXXXXX…»
      .replace(/sk-[A-Za-z0-9]{16,}/g, REDACTED)
      // Заголовок Authorization, если попал в дамп ошибки.
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, `Bearer ${REDACTED}`)
      // Параметр в querystring (на случай нестандартных ошибок прокси).
      .replace(/(api[_-]?key|access[_-]?token|apikey)=([^&\s"']+)/gi, `$1=${REDACTED}`);
  };

  const status = err?.response?.status || null;
  const rawData = err?.response?.data;
  let dataStr = '';
  try {
    dataStr = typeof rawData === 'string' ? rawData : JSON.stringify(rawData);
  } catch { dataStr = ''; }
  return {
    status,
    message: stripKey(err?.message || 'unknown error'),
    detail:  stripKey(dataStr || '').slice(0, 1000),
  };
}

// ── Основной вызов ──────────────────────────────────────────────────────
/**
 * Вызывает DashScope chat/completions (OpenAI-совместимый режим).
 *
 * @param {object}   params
 * @param {string}   params.systemPrompt      — system message (может быть пустой строкой)
 * @param {string}   params.userPrompt        — user message (обязателен, непустой)
 * @param {string}  [params.model]            — переопределяет DASHSCOPE_MODEL
 * @param {number}  [params.temperature=0.1]
 * @param {number}  [params.topP]             — nucleus sampling (0, 1]; не передаётся в body, если undefined
 * @param {number}  [params.maxTokens=16384]
 * @param {number}  [params.timeoutMs]
 * @returns {Promise<{ choice: object, usage: object|null }>}
 *
 * Возвращает первый choice + usage. Любая HTTP/network-ошибка приходит
 * в виде { __dashscopeError: { status, message, detail } } через throw —
 * без утечки API-ключа в сообщении.
 */
async function callDashscope({
  systemPrompt,
  userPrompt,
  model,
  temperature,
  topP,
  maxTokens,
  timeoutMs,
} = {}) {
  if (typeof userPrompt !== 'string' || !userPrompt.trim()) {
    throw new Error('callDashscope: userPrompt is required');
  }
  if (typeof systemPrompt !== 'string') {
    throw new Error('callDashscope: systemPrompt must be a string');
  }

  const apiKey = requireDashscopeApiKey();
  const safeModel = (typeof model === 'string' && model.trim()) ? model.trim() : DASHSCOPE_MODEL_DEFAULT;
  const safeTemperature = Number.isFinite(temperature) ? Number(temperature) : 0.1;
  const safeMaxTokens = Number.isFinite(maxTokens) ? Math.floor(Number(maxTokens)) : 16384;
  const safeTimeout = Number.isFinite(timeoutMs) ? Math.floor(Number(timeoutMs)) : DEFAULT_TIMEOUT_MS;

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model: safeModel,
    messages,
    temperature: safeTemperature,
    max_tokens: safeMaxTokens,
    // Для qwen3.x deep-thinking моделей: отключаем «мыслительный» поток,
    // чтобы получить обычный синхронный ответ с message.content и сохранить
    // совместимость с прежним non-streaming контрактом /acf-json/.
    // (В стрим-режиме DashScope разделяет delta.reasoning_content и delta.content.)
    enable_thinking: false,
  };

  // top_p — nucleus sampling. Включаем в body только если caller явно передал
  // валидное значение в (0, 1], иначе оставляем дефолт DashScope. Малые
  // значения (≤0.1) вместе с temperature=0 нужны вкладке «Сформировать JSON»
  // для строго детерминированного парсинга HTML без галлюцинаций.
  if (Number.isFinite(topP) && topP > 0 && topP <= 1) {
    body.top_p = Number(topP);
  }

  const url = `${DASHSCOPE_BASE_URL}/chat/completions`;

  let response;
  try {
    response = await axios.post(url, body, {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Accept':        'application/json',
      },
      timeout: safeTimeout,
      validateStatus: () => true,
      ...(PROXY_AGENT
        ? { httpAgent: PROXY_AGENT, httpsAgent: PROXY_AGENT, proxy: false }
        : {}),
    });
  } catch (networkError) {
    const safe = _sanitizeAxiosError(networkError);
    // ВАЖНО: логируем ТОЛЬКО санитизированное сообщение — никакого apiKey/Authorization.
    console.error('[dashscope] network error:', safe.message);
    const e = new Error(safe.message);
    e.__dashscope = { kind: 'network', ...safe };
    throw e;
  }

  if (response.status < 200 || response.status >= 300) {
    const safe = _sanitizeAxiosError({ response, message: `HTTP ${response.status}` });
    console.error('[dashscope] HTTP', response.status, safe.detail.slice(0, 500));
    const e = new Error(`DashScope HTTP ${response.status}: ${safe.detail.slice(0, 500)}`);
    e.__dashscope = { kind: 'http', ...safe };
    throw e;
  }

  const data = response.data;
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    const e = new Error('DashScope вернул пустой ответ.');
    e.__dashscope = { kind: 'empty', status: response.status, message: e.message, detail: '' };
    throw e;
  }

  // ── Расчёт стоимости (включаем в usage) ──────────────────────────────
  // До этого DashScope-вызовы НИКАК не учитывались в биллинге (вкладка
  // «Сформировать JSON» уходила в /0/ затрат на admin-dashboard). Теперь
  // адаптер сам считает стоимость по тарифу из priceCalculator и возвращает
  // её в `usage.cost_usd` + `usage.model` (имя реальной модели, как ответил
  // DashScope, либо safeModel — на случай эха `data.model` без префикса).
  // Контракт `{ choice, usage }` остаётся обратно совместимым: добавлены
  // только новые поля, прежние (prompt_tokens / completion_tokens / total_tokens)
  // сохранены.
  const usageRaw = data.usage || null;
  const respondedModel = (typeof data.model === 'string' && data.model.trim())
    ? data.model.trim()
    : safeModel;
  let usage = usageRaw;
  if (usageRaw && Number.isFinite(Number(usageRaw.prompt_tokens))) {
    // completion_tokens может отсутствовать (например, max_tokens=1 + сразу stop)
    // — это нормально, считаем его 0. Стоимость от tOut=0 = 0, так что
    // итоговая cost корректно учитывает только input.
    const tIn  = Number(usageRaw.prompt_tokens)     || 0;
    const tOut = Number(usageRaw.completion_tokens) || 0;
    const costUsd = calcCost('dashscope', tIn, tOut, { model: respondedModel });
    usage = Object.assign({}, usageRaw, {
      model:    respondedModel,
      cost_usd: Number.isFinite(costUsd) ? costUsd : 0,
    });
  }

  return {
    choice: data.choices[0],
    usage,
  };
}

module.exports = {
  callDashscope,
  requireDashscopeApiKey,
  DASHSCOPE_BASE_URL,
  DASHSCOPE_MODEL_DEFAULT,
  // экспортируем для тестов/диагностики
  _internals: { _sanitizeAxiosError, _resolveProxyUrl },
};
