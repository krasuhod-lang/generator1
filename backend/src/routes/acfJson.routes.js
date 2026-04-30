'use strict';

/**
 * /api/acf-json/* — серверный прокси для вкладки «Сформировать JSON».
 *
 * Транспорт: прямой вызов DashScope (Alibaba Model Studio), модель Qwen3.6-Plus,
 * через адаптер backend/src/services/llm/dashscope.adapter.js.
 *
 * Зачем нужен этот прокси:
 *   Фронтенд (frontend/src/views/AcfJsonPage.vue) НЕ должен знать API-ключ
 *   и не должен сам ходить к внешним LLM. Все вызовы идут через сервер,
 *   ключ DASHSCOPE_API_KEY живёт ИСКЛЮЧИТЕЛЬНО в .env (см. .env.example).
 *
 * Главное правило фичи (сохранено): модель НЕ переписывает текст —
 * только оборачивает уже готовый текст в ACF Flexible Content JSON.
 * Этот инвариант обеспечивается system-промптом, который шлёт фронт.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');
const {
  callDashscope,
  DASHSCOPE_BASE_URL,
  DASHSCOPE_MODEL_DEFAULT,
  _internals,
} = require('../services/llm/dashscope.adapter');

const router = express.Router();

// Лимиты входа: чтобы случайный кривой клиент не уронил сервер / бюджет.
const MAX_PROMPT_LEN     = 200000; // символов на каждый промпт
const MAX_OUTPUT_TOKENS  = 32000;  // потолок max_tokens, который пропускаем дальше
// Таймаут до DashScope. ВАЖНО: фронт (frontend/src/views/AcfJsonPage.vue)
// держит axios-таймаут СТРОГО больше этого значения, чтобы при медленном
// ответе сервер успел отдать осмысленное 502, а не получил гонку с фронтом.
// См. также nginx proxy_read_timeout=300s (frontend/docker-nginx.conf).
const REQUEST_TIMEOUT_MS = 240000;

// Rate-limit: формирование JSON может слать десятки чанков подряд,
// поэтому лимит мягкий, но не безграничный.
const dashscopeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Подождите минуту.' },
});

router.use(dashscopeLimiter);

/**
 * GET /api/acf-json/health
 *
 * Диагностический endpoint для вкладки «Сформировать JSON». Используется
 * фронт-кнопкой «Проверить соединение», чтобы быстро понять, на каком уровне
 * ломается «Сеть до сервера недоступна (Failed to fetch). Network Error»:
 *   • если этот запрос возвращает 200 → backend жив, проблема была в
 *     прежнем долгом запросе (timeout / разрыв соединения нгинксом);
 *   • если возвращает 500 c `apiKey:false` → не задан DASHSCOPE_API_KEY в .env;
 *   • если `reachable:false` → backend жив, но не может достучаться до
 *     DashScope (нужно настроить DASHSCOPE_PROXY_*).
 *
 * Безопасность: НЕ возвращает сам ключ или Authorization-заголовок,
 * только факт его наличия (boolean) и хвостовые 4 символа для отладки.
 * Прокси показывается с маскированным паролем (см. _safeProxyLog в адаптере).
 */
router.get('/health', auth, async (req, res) => {
  const apiKeyRaw = (process.env.DASHSCOPE_API_KEY || '').trim();
  const apiKeyPresent = apiKeyRaw.length > 0;
  // Хвостовые символы — только для отладки оператором, не секрет.
  const apiKeyTail = apiKeyPresent ? apiKeyRaw.slice(-4) : '';
  const proxyUrl = (() => {
    try { return _internals._resolveProxyUrl(); } catch { return ''; }
  })();
  const proxyMasked = proxyUrl
    ? proxyUrl.replace(/:([^:@/]+)@/, ':***@').replace(/(api[_-]?key|access[_-]?token|apikey)=([^&\s"']+)/gi, '$1=***')
    : '';

  // Опциональный thick-echo тест: ?thick=1 → второй вызов с user-prompt
  // ~32 KB, чтобы понять, режет ли промежуточный HTTPS-прокси тело
  // запроса. У дешёвых HTTPS-прокси типичный лимит body — 64 KB, и
  // системный промт + JSON-кодированный чанк туда не помещаются — это
  // и есть ровно та причина «Ошибка прокси DashScope: HTTP 413», которую
  // видит пользователь во вкладке «Сформировать JSON». Если тонкий ping
  // (max_tokens=1) проходит, а thick-echo возвращает 413, проблема
  // ИМЕННО в прокси, а не в DashScope/ключе/балансе.
  const thickRequested = String(req.query.thick || '') === '1';
  // 32 KB — половина типичного лимита body у дешёвых HTTPS-прокси (64 KB):
  // достаточно, чтобы триггерить отсечение, и при этом помещается в наш
  // собственный MAX_PROMPT_LEN основного маршрута (200 000 симв.). Если
  // прокси режет на ~16 KB — этот же тест тоже его поймает (проще, чем
  // запускать ступенчатый probing).
  const THICK_BYTES = 32 * 1024;

  const result = {
    backend:    'ok',
    apiKey:     apiKeyPresent,
    apiKeyTail: apiKeyPresent ? `…${apiKeyTail}` : '',
    baseUrl:    DASHSCOPE_BASE_URL,
    model:      DASHSCOPE_MODEL_DEFAULT,
    proxy:      proxyMasked || '(none)',
    reachable:  null,
    latencyMs:  null,
    error:      null,
    // null = тест не запрашивали; иначе — структурный отчёт.
    thick:      thickRequested ? { requestedBytes: THICK_BYTES, ok: null, latencyMs: null, error: null } : null,
  };

  if (!apiKeyPresent) {
    result.error = 'DASHSCOPE_API_KEY не задан в .env';
    return res.status(500).json(result);
  }

  // Минимальный «ping» через chat/completions с max_tokens=1.
  // Это самый надёжный сигнал: проверяет доступность endpoint'а, проксю,
  // валидность ключа и квоту аккаунта одним вызовом. Жёсткий timeout 12 сек.
  const t0 = Date.now();
  try {
    await callDashscope({
      systemPrompt: '',
      userPrompt:   'ping',
      temperature:  0,
      maxTokens:    1,
      timeoutMs:    12000,
    });
    result.reachable = true;
    result.latencyMs = Date.now() - t0;
  } catch (err) {
    result.reachable = false;
    result.latencyMs = Date.now() - t0;
    const meta = err && err.__dashscope;
    if (meta && meta.kind === 'http') {
      result.error = `DashScope ответил HTTP ${meta.status}: ${(meta.detail || meta.message || '').slice(0, 300)}`;
    } else if (meta && meta.kind === 'network') {
      result.error = `Сетевая ошибка до DashScope: ${meta.message}` +
        (proxyUrl ? '' : ' (прокси не задан — для России обычно нужен DASHSCOPE_PROXY_URL / LLM_PROXY_URL)');
    } else if (meta && meta.kind === 'empty') {
      result.error = `DashScope вернул пустой ответ: ${meta.message}`;
    } else {
      // Генерик: санитизируем на всякий случай (как в основном handler'е).
      const safeMsg = String((err && err.message) || 'unknown error')
        .replace(/sk-[A-Za-z0-9]{16,}/g, '***REDACTED***')
        .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***REDACTED***');
      result.error = safeMsg.slice(0, 300);
    }
  }

  // Thick-echo запускаем ТОЛЬКО если тонкий ping прошёл — иначе мы и так
  // знаем, что проблема не в размере body, а в самом канале/ключе/квоте.
  if (thickRequested && result.reachable) {
    const t1 = Date.now();
    try {
      // 32 KB символов 'a' — гарантированно крупное тело, но не упирается
      // в MAX_PROMPT_LEN основного маршрута (200 000 симв. на поле).
      // max_tokens=1 → ответ модели крошечный, значит время round-trip
      // фактически измеряет именно загрузку тела через прокси.
      const filler = 'a'.repeat(THICK_BYTES);
      await callDashscope({
        systemPrompt: '',
        userPrompt:   filler,
        temperature:  0,
        maxTokens:    1,
        timeoutMs:    20000,
      });
      result.thick.ok = true;
      result.thick.latencyMs = Date.now() - t1;
    } catch (err) {
      result.thick.ok = false;
      result.thick.latencyMs = Date.now() - t1;
      const meta = err && err.__dashscope;
      if (meta && meta.kind === 'http' && meta.status === 413) {
        result.thick.error = 'HTTP 413 — промежуточный HTTPS-прокси режет тело запроса. '
          + 'Это и есть корневая причина «Ошибка прокси DashScope: HTTP 413» на вкладке JSON. '
          + 'Решения: (1) переключите режим сборки JSON на «Программный (рекомендуется)» — '
          + 'там запрос к LLM не уходит вообще; (2) смените прокси на тот, у которого нет '
          + 'жёсткого лимита body; (3) уменьшите DEFAULT_CHUNK_LEN.';
      } else if (meta && meta.kind === 'http') {
        result.thick.error = `DashScope ответил HTTP ${meta.status}: ${(meta.detail || meta.message || '').slice(0, 200)}`;
      } else if (meta && meta.kind === 'network') {
        result.thick.error = `Сетевая ошибка на толстом запросе: ${meta.message}`;
      } else {
        const safeMsg = String((err && err.message) || 'unknown error')
          .replace(/sk-[A-Za-z0-9]{16,}/g, '***REDACTED***')
          .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***REDACTED***');
        result.thick.error = safeMsg.slice(0, 300);
      }
    }
  }

  // 200 даже при reachable=false: сам диагностический вызов прошёл, проблема —
  // в downstream (DashScope/прокси), и фронт должен спокойно показать detail.
  // Это отличает «backend жив, провайдер сдох» от «backend сдох».
  return res.json(result);
});

/**
 * POST /api/acf-json/dashscope
 *
 * Body (JSON):
 *   {
 *     systemPrompt: string,     // обязателен (можно пустую строку)
 *     userPrompt:   string,     // обязателен, непустой
 *     model?:       string,     // опц.; по умолчанию DASHSCOPE_MODEL_DEFAULT (qwen3.6-plus)
 *     temperature?: number,     // 0..2, по умолчанию 0.1
 *     max_tokens?:  number      // 1..MAX_OUTPUT_TOKENS, по умолчанию 16384
 *   }
 *
 * Возвращает первый choice + usage — контракт идентичен прежнему
 * AITunnel-прокси, чтобы фронт-логика расчёта стоимости / разбора
 * `message.content` / `finish_reason` НЕ менялась:
 *   {
 *     choice: { message: { content: '...' }, finish_reason: 'stop' | 'length' | ... },
 *     usage:  { prompt_tokens, completion_tokens, total_tokens } | null
 *   }
 *
 * Ошибки сети / HTTP — корректный JSON `{ error: '...' }` без утечки API-ключа
 * (адаптер DashScope санитизирует сообщения, см. _sanitizeAxiosError).
 */
router.post('/dashscope', auth, async (req, res) => {
  const {
    systemPrompt,
    userPrompt,
    model,
    temperature,
    max_tokens: maxTokens,
  } = req.body || {};

  // ── Валидация входа ──────────────────────────────────────────────────
  if (typeof systemPrompt !== 'string' || typeof userPrompt !== 'string') {
    return res.status(400).json({
      error: 'systemPrompt and userPrompt must be strings',
    });
  }
  if (systemPrompt.length > MAX_PROMPT_LEN || userPrompt.length > MAX_PROMPT_LEN) {
    return res.status(413).json({
      error: `Prompt too long (limit ${MAX_PROMPT_LEN} chars per field)`,
    });
  }
  if (!userPrompt.trim()) {
    return res.status(400).json({ error: 'userPrompt must not be empty' });
  }

  const safeTemperature = Number.isFinite(temperature) ? Number(temperature) : 0.1;
  if (safeTemperature < 0 || safeTemperature > 2) {
    return res.status(400).json({ error: 'temperature must be in [0, 2]' });
  }

  const safeMaxTokens = Number.isFinite(maxTokens) ? Math.floor(Number(maxTokens)) : 16384;
  if (safeMaxTokens < 1 || safeMaxTokens > MAX_OUTPUT_TOKENS) {
    return res.status(400).json({
      error: `max_tokens must be in [1, ${MAX_OUTPUT_TOKENS}]`,
    });
  }

  const safeModel = (typeof model === 'string' && model.trim())
    ? model.trim()
    : DASHSCOPE_MODEL_DEFAULT;

  // ── Вызов DashScope через адаптер ────────────────────────────────────
  try {
    const { choice, usage } = await callDashscope({
      systemPrompt,
      userPrompt,
      model:       safeModel,
      temperature: safeTemperature,
      maxTokens:   safeMaxTokens,
      timeoutMs:   REQUEST_TIMEOUT_MS,
    });
    return res.json({ choice, usage });
  } catch (err) {
    // Адаптер кладёт детали ошибки в err.__dashscope с уже санитизированным
    // сообщением (без API-ключа / Authorization-заголовка).
    const meta = err && err.__dashscope;
    if (meta && meta.kind === 'http') {
      return res.status(meta.status || 502).json({
        error: `Ошибка DashScope ${meta.status}: ${meta.detail || meta.message}`,
      });
    }
    if (meta && meta.kind === 'network') {
      return res.status(502).json({
        error: `Сервер не смог достучаться до DashScope: ${meta.message}`,
      });
    }
    if (meta && meta.kind === 'empty') {
      return res.status(502).json({ error: meta.message });
    }
    // Конфигурационная ошибка (например, DASHSCOPE_API_KEY не задан).
    // Дополнительно прогоняем сообщение через те же sk-/Bearer-регулярки, что и
    // адаптер — чтобы статанализ (CodeQL js/clear-text-logging) видел: ни один
    // секрет не доходит до console.* через эту ветку.
    const rawMsg = (err && err.message) || 'unknown error';
    const safeMsg = String(rawMsg)
      .replace(/sk-[A-Za-z0-9]{16,}/g, '***REDACTED***')
      .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ***REDACTED***');
    console.error('[acf-json] DashScope call failed:', safeMsg);
    return res.status(500).json({ error: safeMsg });
  }
});

module.exports = router;
