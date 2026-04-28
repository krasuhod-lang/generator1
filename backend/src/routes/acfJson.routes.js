'use strict';

/**
 * /api/acf-json/* — серверный прокси к AITunnel для вкладки «Сформировать JSON».
 *
 * Зачем нужен этот прокси:
 *   Раньше фронтенд (frontend/src/views/AcfJsonPage.vue) звонил напрямую
 *   из браузера на https://api.aitunnel.ru. Если у пользователя
 *   сетевые проблемы / VPN / провайдер блокирует домен — fetch падал
 *   c "Failed to fetch" и формирование JSON ломалось. Чтобы доступность
 *   AITunnel определялась только сервером (где живёт приложение),
 *   а не клиентом, все запросы теперь идут через этот эндпоинт.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const axios     = require('axios');
const auth      = require('../middleware/auth');

const router = express.Router();

// ── Конфигурация AITunnel (с дефолтами, идентичными прежнему фронт-коду) ──
// Ключ берём ИЗ ENV (предпочтительно), но оставляем зашитый дефолт, чтобы
// функционал «Сформировать JSON» работал «из коробки», как до рефакторинга.
const AITUNNEL_URL = (
  process.env.AITUNNEL_URL || 'https://api.aitunnel.ru/v1/chat/completions'
).trim();
const AITUNNEL_API_KEY_DEFAULT = 'sk-aitunnel-S81NPYt7iGa9X5Lsx9g4e8D9WXlAh5cm';
const AITUNNEL_API_KEY = (
  process.env.AITUNNEL_API_KEY || AITUNNEL_API_KEY_DEFAULT
).trim();
const AITUNNEL_MODEL_DEFAULT = process.env.AITUNNEL_MODEL || 'qwen3.5-plus-02-15';

// Ограничения, чтобы случайный кривой клиент не уронил сервер / бюджет.
const MAX_PROMPT_LEN     = 200000; // символов на каждый промпт
const MAX_OUTPUT_TOKENS  = 32000;  // потолок max_tokens, который пропускаем дальше
// Таймаут до AITunnel. ВАЖНО: фронт (frontend/src/views/AcfJsonPage.vue)
// держит axios-таймаут СТРОГО больше этого значения, чтобы при медленном
// ответе AITunnel сервер успел отдать осмысленное 502, а не получил гонку
// с фронтовым axios "timeout of Nms exceeded". См. также nginx
// proxy_read_timeout=300s (frontend/docker-nginx.conf).
const REQUEST_TIMEOUT_MS = 240000;

// Rate-limit: формирование JSON может слать десятки чанков подряд,
// поэтому лимит мягкий, но не безграничный.
const aitunnelLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к AITunnel. Подождите минуту.' },
});

router.use(aitunnelLimiter);

/**
 * POST /api/acf-json/aitunnel
 *
 * Body (JSON):
 *   {
 *     systemPrompt: string,     // обязателен (можно пустую строку)
 *     userPrompt:   string,     // обязателен
 *     model?:       string,     // опц.; по умолчанию AITUNNEL_MODEL_DEFAULT
 *     temperature?: number,     // 0..2, по умолчанию 0.1
 *     max_tokens?:  number      // 1..MAX_OUTPUT_TOKENS, по умолчанию 16384
 *   }
 *
 * Возвращает ровно тот же объект choice, что отдаёт AITunnel, плюс usage:
 *   {
 *     choice: { message: { content: '...' }, finish_reason: 'stop' | 'length' | ... },
 *     usage:  { prompt_tokens, completion_tokens, total_tokens } | null
 *   }
 *
 * `usage` нужен фронту (AcfJsonPage.vue) для расчёта стоимости JSON-задачи
 * по тарифам Qwen3.5 Plus в ₽ (см. INPUT_PRICE_RUB/OUTPUT_PRICE_RUB там же).
 *
 * При ошибке сети/HTTP — корректный JSON с полем `error`.
 */
router.post('/aitunnel', auth, async (req, res) => {
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
    : AITUNNEL_MODEL_DEFAULT;

  if (!AITUNNEL_API_KEY) {
    return res.status(500).json({ error: 'AITUNNEL_API_KEY is not configured on server' });
  }

  const body = {
    model: safeModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user',   content: userPrompt },
    ],
    temperature: safeTemperature,
    max_tokens:  safeMaxTokens,
  };

  // ── Вызов AITunnel с сервера ─────────────────────────────────────────
  let response;
  try {
    response = await axios.post(AITUNNEL_URL, body, {
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${AITUNNEL_API_KEY}`,
        'Accept':        'application/json',
      },
      timeout: REQUEST_TIMEOUT_MS,
      // Сами решаем, что считать ошибкой — нужно прокинуть исходный статус.
      validateStatus: () => true,
    });
  } catch (networkError) {
    // ECONNREFUSED / ETIMEDOUT / ENOTFOUND / DNS-сбой и т.п. — это уже
    // проблема СЕРВЕРА (а не клиента), сообщаем явно.
    console.error('[acf-json] AITunnel network error:', networkError.message);
    return res.status(502).json({
      error: `Сервер не смог достучаться до AITunnel: ${networkError.message}`,
    });
  }

  if (response.status < 200 || response.status >= 300) {
    const detail = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);
    console.error('[acf-json] AITunnel HTTP', response.status, detail.slice(0, 500));
    return res.status(response.status).json({
      error: `Ошибка AITunnel ${response.status}: ${detail.slice(0, 1000)}`,
    });
  }

  const data = response.data;
  if (!data || !Array.isArray(data.choices) || data.choices.length === 0) {
    return res.status(502).json({ error: 'AITunnel вернул пустой ответ.' });
  }

  // Возвращаем фронту первый choice + usage (prompt/completion-токены), чтобы
  // фронт мог посчитать стоимость генерации. AITunnel отдаёт OpenAI-совместимое
  // поле `usage: { prompt_tokens, completion_tokens, total_tokens }`.
  return res.json({
    choice: data.choices[0],
    usage:  data.usage || null,
  });
});

module.exports = router;
