'use strict';

/**
 * grok.adapter.js — адаптер для x.ai Grok (OpenAI-совместимый API).
 *
 * Используется как альтернатива Gemini (Stage 3/5/6, AI-Copilot редактор,
 * meta-tags) — выбор провайдера задаётся `task.llm_provider = 'grok'`
 * и роутится в backend/src/services/llm/callLLM.js.
 *
 * Совместимость с callGemini():
 *   - возвращает { text, tokensIn, tokensOut, model, finishReason }
 *   - принимает (systemInstruction, userPrompt, options)
 *   - поддерживает plainText (для streamGenerate-фолбэка редактора)
 *   - НЕ поддерживает cachedContent — возвращает обычный ответ, а
 *     onCacheMiss обработка не нужна (callLLM сам очищает кэш-имя
 *     при cache miss; для Grok мы просто не передаём cachedContent).
 *
 * Отличия от Gemini API:
 *   - JSON-mode задаётся через response_format: { type: 'json_object' }
 *     (как в OpenAI). Если plainText=true — не выставляем.
 *   - Tokens в `usage.prompt_tokens` / `usage.completion_tokens`.
 *
 * Прокси: тот же стек, что у Gemini. По умолчанию используется LLM_PROXY_*
 * (общий для всех LLM-провайдеров). Для обратной совместимости поддерживается
 * также XAI_PROXY_* (приоритет: XAI_* > LLM_PROXY_* > GEMINI_PROXY_*).
 *
 * ⚠ Имя модели — env XAI_MODEL (default 'grok-4'). По состоянию на 2026-04
 * валидные имена в публичном API x.ai: grok-4, grok-code-fast-1, grok-2-vision.
 * Внутренние alias-имена надо подтверждать у провайдера.
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const XAI_BASE_URL = (process.env.XAI_BASE_URL || 'https://api.x.ai/v1').replace(/\/$/, '');
// Default — рассуждающая (reasoning) версия Grok-4. Переопределяется
// XAI_MODEL в .env. Для reasoning-моделей x.ai НЕ принимает
// response_format=json_object (см. _isReasoningModel ниже) — поэтому JSON-strict
// гарантируется только инструкцией в system-промпте.
const XAI_MODEL    = process.env.XAI_MODEL || 'grok-4.20-0309-reasoning';

// Reasoning-модели: имена с маркером 'reasoning' / 'r1' / суффиксами «-thinking».
// Нужно знать, чтобы:
//   1) НЕ форсить response_format=json_object (x.ai вернёт 400 для reasoning),
//   2) при пустом content попытаться извлечь reasoning_content (некоторые
//      reasoning-модели кладут финальный ответ в этот альтернативный канал).
function _isReasoningModel(model) {
  return /reasoning|thinking|-r1\b|-r2\b/i.test(String(model || ''));
}

// Лимит длины суммарного входа (защита от отправки мегабайтов в API).
const MAX_GROK_INPUT_LENGTH = 200000;

function requireXaiApiKey() {
  const k = (process.env.XAI_API_KEY || '').trim();
  if (!k) {
    throw new Error(
      'XAI_API_KEY не задан. Добавьте его в .env (см. .env.example) — ' +
      'ключ нужен для вызовов Grok при llm_provider=grok.'
    );
  }
  return k;
}

// ─────────────────────────────────────────────────────────────────────
// Прокси: используем тот же стек, что у Gemini, но с приоритетом своих
// XAI_PROXY_* / LLM_PROXY_* переменных. Резолвинг — копия логики gemini,
// но без хардкоженного fallback (см. point 9.1 в задаче).
// ─────────────────────────────────────────────────────────────────────

function _normalizeProxyUrl(raw) {
  if (!raw) return '';
  raw = raw.trim();
  if (!raw) return '';
  if (raw.includes('@')) return raw;

  const withProto = raw.match(/^(https?:\/\/)([^:]+):([^:]+):([^:]+):(\d+)$/);
  if (withProto) {
    const [, proto, user, pass, host, port] = withProto;
    return `${proto}${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }

  const noParts = raw.match(/^([^:]+):([^:]+):([^:]+):([^:]+)$/);
  if (noParts) {
    const [, p1, p2, p3, p4] = noParts;
    const isIP = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
    const isHostname = (s) => /^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(s) && s.includes('.');
    const isHost = (s) => isIP(s) || isHostname(s);
    const isPort = (s) => /^\d+$/.test(s);
    let user, pass, host, port;
    if (isHost(p3) && isPort(p4))      [user, pass, host, port] = [p1, p2, p3, p4];
    else if (isHost(p1) && isPort(p2)) [host, port, user, pass] = [p1, p2, p3, p4];
    else return raw;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  return raw;
}

function _resolveProxyUrl(suffix = '') {
  // 1. Свои XAI_PROXY_* переменные (специфичные для Grok)
  const xaiFull = process.env[`XAI_PROXY_URL${suffix}`] || '';
  if (xaiFull) return _normalizeProxyUrl(xaiFull);
  const xaiHost = process.env[`XAI_PROXY_HOST${suffix}`] || '';
  const xaiPort = process.env[`XAI_PROXY_PORT${suffix}`] || '';
  if (xaiHost && xaiPort) {
    const u = process.env[`XAI_PROXY_USER${suffix}`] || '';
    const p = process.env[`XAI_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`XAI_PROXY_PROTO${suffix}`] || 'http';
    if (u && p) return `${proto}://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${xaiHost}:${xaiPort}`;
    return `${proto}://${xaiHost}:${xaiPort}`;
  }

  // 2. Общие LLM_PROXY_* (рекомендуется для одного источника прокси)
  const llmFull = process.env[`LLM_PROXY_URL${suffix}`] || '';
  if (llmFull) return _normalizeProxyUrl(llmFull);
  const llmHost = process.env[`LLM_PROXY_HOST${suffix}`] || '';
  const llmPort = process.env[`LLM_PROXY_PORT${suffix}`] || '';
  if (llmHost && llmPort) {
    const u = process.env[`LLM_PROXY_USER${suffix}`] || '';
    const p = process.env[`LLM_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`LLM_PROXY_PROTO${suffix}`] || 'http';
    if (u && p) return `${proto}://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${llmHost}:${llmPort}`;
    return `${proto}://${llmHost}:${llmPort}`;
  }

  // 3. Fallback — переиспользуем GEMINI_PROXY_* (тот же провайдер прокси)
  const gemFull = process.env[`GEMINI_PROXY_URL${suffix}`] || '';
  if (gemFull) return _normalizeProxyUrl(gemFull);
  const gemHost = process.env[`GEMINI_PROXY_HOST${suffix}`] || '';
  const gemPort = process.env[`GEMINI_PROXY_PORT${suffix}`] || '';
  if (gemHost && gemPort) {
    const u = process.env[`GEMINI_PROXY_USER${suffix}`] || '';
    const p = process.env[`GEMINI_PROXY_PASS${suffix}`] || '';
    const proto = process.env[`GEMINI_PROXY_PROTO${suffix}`] || 'http';
    if (u && p) return `${proto}://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${gemHost}:${gemPort}`;
    return `${proto}://${gemHost}:${gemPort}`;
  }

  // 4. Системная HTTPS_PROXY (только для основного)
  if (!suffix) {
    const sys = process.env.HTTPS_PROXY || process.env.https_proxy || '';
    if (sys) return sys;
  }
  return '';
}

const PROXY_URLS = [];
const PRIMARY_PROXY = _resolveProxyUrl('');
if (PRIMARY_PROXY) PROXY_URLS.push(PRIMARY_PROXY);
for (let i = 2; i <= 5; i++) {
  const px = _resolveProxyUrl(`_${i}`);
  if (px) PROXY_URLS.push(px);
}

let activeProxyIdx = 0;

function _safeProxyLog(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/:([^:@]+)@/, ':***@');
  }
}

function _buildProxyAgent(idx) {
  if (idx < 0 || idx >= PROXY_URLS.length) return undefined;
  try { return new HttpsProxyAgent(PROXY_URLS[idx]); }
  catch (e) {
    console.warn(`[grok] Неверный прокси [${idx}], пропускаем:`, e.message);
    return undefined;
  }
}

if (PROXY_URLS.length > 0) {
  console.log(`[grok] Прокси настроен (${PROXY_URLS.length} шт):`);
  PROXY_URLS.forEach((u, i) => console.log(`  [${i}] ${_safeProxyLog(u)}`));
} else {
  console.warn('[grok] ⚠ Прокси НЕ задан. Запросы к x.ai (Grok) из России будут падать.');
  console.warn('[grok]   Задайте XAI_PROXY_* / LLM_PROXY_* / GEMINI_PROXY_* в .env.');
}

// ─────────────────────────────────────────────────────────────────────
// callGrok — основной вызов
// ─────────────────────────────────────────────────────────────────────

/**
 * Вызывает Grok (x.ai) chat/completions. Контракт совпадает с callGemini().
 *
 * @param {string} systemInstruction
 * @param {string} userPrompt
 * @param {object} [options]
 * @param {number} [options.temperature=0.4]
 * @param {number} [options.maxTokens=8192]
 * @param {number} [options.timeoutMs=180000]
 * @param {string} [options.model]      — переопределяет XAI_MODEL
 * @param {boolean}[options.plainText]  — true → НЕ форсим JSON-режим
 * @returns {Promise<{ text, tokensIn, tokensOut, model, finishReason }>}
 */
async function callGrok(systemInstruction, userPrompt, options = {}) {
  if (typeof systemInstruction !== 'string' || typeof userPrompt !== 'string') {
    throw new Error('systemInstruction and userPrompt must be strings');
  }
  if ((systemInstruction + userPrompt).length > MAX_GROK_INPUT_LENGTH) {
    throw new Error('Input text too long');
  }

  const {
    temperature = 0.4,
    maxTokens   = 8192,
    timeoutMs   = 180000,
    model       = XAI_MODEL,
    plainText   = false,
  } = options;

  if (temperature < 0 || temperature > 2) throw new Error('Invalid temperature');
  if (maxTokens < 1 || maxTokens > 32000) throw new Error('Invalid maxTokens');
  if (timeoutMs < 1000 || timeoutMs > 300000) throw new Error('Invalid timeout');

  const apiKey = requireXaiApiKey();

  // ── messages ───────────────────────────────────────────────────────
  // JSON-strict guard — тот же подход, что у Gemini: вписываем в system,
  // когда выводим JSON. Для plainText — оставляем только пользовательский
  // system-промпт.
  const JSON_STRICT_GUARD =
    'You are a strict REST API. Output ONLY valid JSON. Do not wrap in Markdown. ' +
    'Never use trailing commas. CRITICAL RULES: ' +
    '1) NEVER use double quotes inside string values (use single quotes \'\' instead). ' +
    '2) Always enclose JSON keys in double quotes. ' +
    '3) NEVER use unescaped newlines inside string values.';

  const messages = [];
  const sysParts = [];
  if (!plainText) sysParts.push(JSON_STRICT_GUARD);
  if (systemInstruction && systemInstruction.trim()) sysParts.push(systemInstruction);
  if (sysParts.length) {
    messages.push({ role: 'system', content: sysParts.join('\n\n') });
  }
  messages.push({ role: 'user', content: userPrompt });

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  // x.ai поддерживает OpenAI-style JSON-mode — НО только для НЕ reasoning моделей.
  // Для reasoning-моделей (grok-4.20-...-reasoning) сервер вернёт 400
  // («response_format not supported for reasoning models»). Поэтому JSON-strict
  // гарантируется только JSON_STRICT_GUARD в system-промпте.
  if (!plainText && !_isReasoningModel(model)) {
    body.response_format = { type: 'json_object' };
  }

  const url = `${XAI_BASE_URL}/chat/completions`;
  const headers = {
    'Content-Type':  'application/json',
    'Authorization': `Bearer ${apiKey}`,
    'Accept':        'application/json',
  };

  // Прокси обязателен (как и для Gemini): без прокси x.ai из России
  // нестабилен, к тому же часть IP-диапазонов RU забанена. Запрос напрямую
  // запрещён — это специально, чтобы избежать «случайных» обходов.
  if (PROXY_URLS.length === 0) {
    throw new Error(
      'Прокси для Grok (x.ai) не задан! Запросы напрямую запрещены.\n' +
      'Задайте в .env (рекомендуется — компонентами) одну из групп:\n' +
      '  XAI_PROXY_HOST / XAI_PROXY_PORT / XAI_PROXY_USER / XAI_PROXY_PASS\n' +
      'или общие для всех LLM:\n' +
      '  LLM_PROXY_HOST / LLM_PROXY_PORT / LLM_PROXY_USER / LLM_PROXY_PASS\n' +
      'или полной строкой:\n' +
      '  XAI_PROXY_URL="http://login:password@ip:port"\n' +
      'В крайнем случае — переиспользуются GEMINI_PROXY_* (тот же провайдер).\n' +
      'Затем: docker compose down && docker compose up -d --build'
    );
  }

  const totalAttempts = PROXY_URLS.length;
  let lastError = null;

  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    const proxyIdx   = (activeProxyIdx + attempt) % PROXY_URLS.length;
    const proxyAgent = _buildProxyAgent(proxyIdx);
    if (!proxyAgent) {
      lastError = new Error(`Grok proxy [${proxyIdx}] agent creation failed`);
      if (attempt < totalAttempts - 1) continue;
      throw lastError;
    }

    let response;
    try {
      response = await axios.post(url, body, {
        timeout:        timeoutMs,
        headers,
        validateStatus: null,
        httpsAgent:     proxyAgent,
        proxy:          false,
      });
    } catch (networkErr) {
      // Подробный лог: куда шли, через какой прокси, какой код/errno.
      const proxyLabel = `прокси [${proxyIdx}] ${_safeProxyLog(PROXY_URLS[proxyIdx])}`;
      const errCode = networkErr.code || 'UNKNOWN';
      const isTimeout = /timeout/i.test(networkErr.message) || errCode === 'ECONNABORTED';
      const is407 = networkErr.message && (networkErr.message.includes('407') || networkErr.message.includes('Proxy Authentication Required'));
      const reason = is407
        ? '407 Proxy Auth Required — неверный логин/пароль прокси'
        : isTimeout
          ? `таймаут ${timeoutMs}ms — прокси молчит или x.ai недоступен через этот IP`
          : errCode === 'ECONNREFUSED' ? 'прокси недоступен (ECONNREFUSED) — проверьте host/port'
          : errCode === 'ENOTFOUND'    ? 'DNS не разрешает host прокси (ENOTFOUND) — опечатка?'
          : `network ${errCode}: ${networkErr.message}`;
      console.error(`[grok] ❌ ${proxyLabel} → ${url} (model=${model}) — ${reason}`);
      lastError = networkErr;
      lastError.isDeterministic = is407;
      if (attempt < totalAttempts - 1) {
        console.log(`[grok] Переключаемся на следующий прокси...`);
        continue;
      }
      throw lastError;
    }

    // 5xx / 429 — не маркируем определённой ошибкой, callLLM ретрайнет.
    if (response.status === 429 || response.status === 503) {
      const detail = response.data?.error?.message || JSON.stringify(response.data || '').slice(0, 200);
      console.warn(`[grok] ⚠ HTTP ${response.status} (rate limit / overload) через прокси [${proxyIdx}] (model=${model}) — ${detail}`);
      const err = new Error(`Grok rate limit / overload: HTTP ${response.status} — ${detail}`);
      err.status = response.status;
      throw err;
    }
    if (response.status === 407) {
      console.error(`[grok] ❌ HTTP 407 от прокси [${proxyIdx}] ${_safeProxyLog(PROXY_URLS[proxyIdx])} — проверьте логин/пароль прокси (XAI_PROXY_* / LLM_PROXY_* / GEMINI_PROXY_*)`);
      const err = new Error(`Grok proxy authentication failed (407) [proxy ${proxyIdx}]`);
      err.isDeterministic = true;
      lastError = err;
      if (attempt < totalAttempts - 1) continue;
      throw err;
    }
    if (response.status !== 200) {
      const detail = response.data?.error?.message
                  || response.data?.error
                  || JSON.stringify(response.data || '').slice(0, 300);
      // Детальный лог: status + body + классификация
      let hint = '';
      if (response.status === 401) hint = ' — проверьте XAI_API_KEY (неверный/просрочен)';
      else if (response.status === 403) hint = ' — ключ валиден, но нет доступа к модели/тарифу';
      else if (response.status === 404) hint = ` — модель «${model}» не найдена в x.ai. Проверьте XAI_MODEL (актуальные имена: grok-4, grok-4.20-0309-reasoning и т.п.)`;
      else if (response.status === 400 && /response_format/i.test(String(detail))) hint = ` — модель «${model}» не поддерживает JSON-mode. Проверьте, что _isReasoningModel() помечает её корректно.`;
      else if (response.status >= 500) hint = ' — сбой на стороне x.ai, callLLM повторит запрос';
      console.error(`[grok] ❌ HTTP ${response.status} от x.ai (model=${model}, proxy=${proxyIdx}): ${detail}${hint}`);
      const fullMsg = `Grok API error ${response.status}: ${detail} [proxy ${proxyIdx}, model ${model}]${hint}`;
      const err = new Error(fullMsg);
      // 4xx — детерминированная ошибка (auth, model not found, etc.)
      if (response.status >= 400 && response.status < 500) {
        err.isDeterministic = true;
      }
      throw err;
    }

    // ── успех — pin proxy ──
    if (proxyIdx !== activeProxyIdx) {
      console.log(`[grok] Прокси [${proxyIdx}] работает — запоминаем как активный`);
      activeProxyIdx = proxyIdx;
    }
    return _parseGrokResponse(response, model);
  }

  if (lastError) {
    lastError.isDeterministic = true;
    throw lastError;
  }
  throw new Error('All Grok proxies exhausted');
}

function _parseGrokResponse(resp, requestedModel) {
  const status = resp.status;
  if (status !== 200) {
    const detail = resp.data?.error?.message || JSON.stringify(resp.data).slice(0, 300);
    const err = new Error(`Grok API error ${status}: ${detail}`);
    if (status >= 400 && status < 500) err.isDeterministic = true;
    throw err;
  }

  const data    = resp.data || {};
  const choice  = data.choices?.[0] || {};
  // Reasoning-модели x.ai иногда кладут финальный ответ в `reasoning_content`,
  // оставляя `content` пустым. Берём content, при пустоте — fallback'ом
  // reasoning_content (отсекая <think>…</think> блоки если они есть).
  let text = choice.message?.content || '';
  if (!text && choice.message?.reasoning_content) {
    const rc = String(choice.message.reasoning_content);
    text = rc.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (text) {
      console.log(`[grok] content пуст, использован reasoning_content (${text.length} символов)`);
    }
  }
  const usage   = data.usage || {};
  const tokensIn  = usage.prompt_tokens     || 0;
  const tokensOut = usage.completion_tokens || 0;
  const finishReason = choice.finish_reason || '';

  if (!text) {
    if (finishReason === 'length') {
      console.error(`[grok] ❌ Ответ обрезан max_tokens (output=${tokensOut}, model=${requestedModel}). Увеличьте maxTokens.`);
      const err = new Error(`Grok truncated by max_tokens (output=${tokensOut} tokens, model=${requestedModel}). Increase max_tokens.`);
      err.isDeterministic = true;
      err.finishReason = finishReason;
      throw err;
    }
    if (finishReason === 'content_filter') {
      console.error(`[grok] ❌ Ответ заблокирован content_filter (model=${requestedModel})`);
      const err = new Error('Grok blocked response (finish_reason=content_filter)');
      err.isDeterministic = true;
      err.finishReason = finishReason;
      throw err;
    }
    console.error(`[grok] ❌ Пустой ответ x.ai: finish_reason=${finishReason || 'UNKNOWN'}, model=${requestedModel}, usage=${JSON.stringify(usage)}`);
    throw new Error(`Grok returned empty response (finish_reason=${finishReason || 'UNKNOWN'}, model=${requestedModel})`);
  }

  return {
    text,
    tokensIn,
    tokensOut,
    model: data.model || requestedModel,
    finishReason,
  };
}

/**
 * streamGenerateGrok — фолбэк-имплементация потоковой генерации.
 * x.ai поддерживает OpenAI-style SSE через `stream: true`. В этом MVP
 * мы делаем простой не-потоковый вызов callGrok({plainText:true}) и эмитим
 * результат одним чанком — этого достаточно для AI-Copilot редактора
 * (UI всё равно получает финальный текст). Полноценный SSE-стрим
 * можно добавить позже, не меняя контракт.
 *
 * @returns {Promise<{ text, tokensIn, tokensOut, aborted, model, finishReason, fallbackUsed:true }>}
 */
async function streamGenerateGrok(systemInstruction, userPrompt, options = {}) {
  const {
    onChunk     = () => {},
    shouldAbort = () => false,
    temperature = 0.6,
    maxTokens   = 8192,
    timeoutMs   = 180000,
    model       = XAI_MODEL,
  } = options;

  if (shouldAbort()) {
    return { text: '', tokensIn: 0, tokensOut: 0, aborted: true, model, finishReason: null, fallbackUsed: true };
  }

  const r = await callGrok(systemInstruction, userPrompt, {
    temperature,
    maxTokens,
    timeoutMs: Math.min(timeoutMs, 300000),
    model,
    plainText: true,
  });

  if (r && r.text) {
    try { onChunk(r.text); } catch (e) {
      console.warn('[grok-stream] onChunk threw:', e.message);
    }
  }
  return {
    text:         r.text || '',
    tokensIn:     r.tokensIn  || 0,
    tokensOut:    r.tokensOut || 0,
    aborted:      false,
    model:        r.model || model,
    finishReason: r.finishReason || null,
    fallbackUsed: true,
  };
}

module.exports = { callGrok, streamGenerateGrok, XAI_MODEL };
