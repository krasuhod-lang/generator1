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
  DASHSCOPE_MODEL_DEFAULT,
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
    const msg = (err && err.message) || 'unknown error';
    console.error('[acf-json] DashScope call failed:', msg);
    return res.status(500).json({ error: msg });
  }
});

module.exports = router;
