'use strict';

/**
 * Nano Banana Pro adapter.
 *
 * Генерация изображений через Google Generative API, модель по умолчанию
 * `gemini-3-pro-image-preview` (alias «Nano Banana Pro»). Используется
 * генератором ссылочной статьи И генератором информационной статьи в блог
 * (последний слайсит ответ до 1 обложки) — никакие другие модули
 * существующего пайплайна на него не завязаны.
 *
 * Ключ берётся из того же GEMINI_API_KEY (см. secrets handling в репозитории):
 * кросс-проектный стандарт — один ключ на все Gemini-сервисы.
 *
 * Прокси обязателен (parity с gemini.adapter.js / grok.adapter.js).
 * Резолвинг переиспользует gemini.adapter.js, чтобы пользователь, настроивший
 * прокси один раз для текстового Gemini (включая запасные слоты
 * `GEMINI_PROXY_URL_2 … _5` и провайдер-формат `login:password:ip:port`),
 * автоматически получал работающую генерацию обложек. Полная цепочка:
 *   1) LINK_ARTICLE_IMAGE_PROXY_URL                       (узкая настройка для image-gen)
 *   2) LLM_PROXY_URL / LLM_PROXY_HOST+PORT (+USER/PASS)   (общий канал для всех LLM)
 *   3) GEMINI_PROXY_URL[''/_2/_3/_4/_5] / GEMINI_PROXY_HOST+PORT (+USER/PASS)
 *      — через getGeminiProxyUrls() (та же нормализация и тот же fallback,
 *      что и у текстовых вызовов Gemini)
 *   4) HTTPS_PROXY / https_proxy                          (системная переменная)
 * Если ни один прокси не задан / ни один не парсится — выкидываем ошибку.
 */

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const {
  normalizeProxyUrl,
  getGeminiProxyUrls,
} = require('../llm/gemini.adapter');

const IMAGE_MODEL = process.env.LINK_ARTICLE_IMAGE_MODEL || 'gemini-3-pro-image-preview';
const GEMINI_BASE_URL =
  (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/models').replace(/\/$/, '');

// Жёстко ограничиваем предел размера base64 изображения (защита от raw-bomb
// ответа API). ~5 МБ base64 = ~3.7 МБ бинарника — достаточно для 1024x1024 PNG.
const MAX_IMAGE_BASE64_BYTES = 8 * 1024 * 1024;

function requireGeminiApiKey() {
  const k = (process.env.GEMINI_API_KEY || '').trim();
  if (!k) {
    throw new Error(
      'GEMINI_API_KEY не задан — Nano Banana Pro не может сгенерировать изображение. ' +
      'Добавьте ключ в .env.'
    );
  }
  return k;
}

/**
 * Возвращает упорядоченный список (без дубликатов) кандидатов прокси-URL для
 * генерации изображений. Каждый элемент уже нормализован к виду
 * `http(s)://[user:pass@]host:port` через normalizeProxyUrl(), поэтому может
 * быть напрямую передан в HttpsProxyAgent.
 */
function resolveImageProxyUrls() {
  const candidates = [];

  // 1. Специфичный для image-gen прокси (узкая настройка под Link/Info-Article).
  if (process.env.LINK_ARTICLE_IMAGE_PROXY_URL) {
    candidates.push(process.env.LINK_ARTICLE_IMAGE_PROXY_URL.trim());
  }

  // 2. Общий LLM_PROXY_* — рекомендованный «один источник для всех LLM».
  if (process.env.LLM_PROXY_URL) {
    candidates.push(process.env.LLM_PROXY_URL.trim());
  } else if (process.env.LLM_PROXY_HOST && process.env.LLM_PROXY_PORT) {
    const u = process.env.LLM_PROXY_USER || '';
    const p = process.env.LLM_PROXY_PASS || '';
    const proto = process.env.LLM_PROXY_PROTO || 'http';
    if (u && p) {
      candidates.push(
        `${proto}://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${process.env.LLM_PROXY_HOST}:${process.env.LLM_PROXY_PORT}`
      );
    } else {
      candidates.push(`${proto}://${process.env.LLM_PROXY_HOST}:${process.env.LLM_PROXY_PORT}`);
    }
  }

  // 3. Все GEMINI_PROXY_* (основной + _2/_3/_4/_5) через шаренный резолвер
  //    текстового адаптера. Это покрывает:
  //      - провайдер-формат GEMINI_PROXY_URL="login:password:ip:port"
  //        (нормализуется внутрь корректного URL),
  //      - запасные слоты GEMINI_PROXY_URL_2 … _5,
  //      - HTTPS_PROXY как нижний системный уровень (он же добавляется ниже,
  //        но гарантированно попадает и через getGeminiProxyUrls()).
  for (const u of getGeminiProxyUrls()) {
    if (u) candidates.push(u);
  }

  // 4. Системный HTTPS_PROXY — на случай, если getGeminiProxyUrls() пуст
  //    (например, ни один GEMINI_PROXY_* не задан, но HTTPS_PROXY есть).
  const sys = (process.env.HTTPS_PROXY || process.env.https_proxy || '').trim();
  if (sys) candidates.push(sys);

  // Нормализация + дедупликация (сохраняем порядок).
  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    const norm = normalizeProxyUrl(raw);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}

function buildProxyAgent() {
  const urls = resolveImageProxyUrls();
  for (const url of urls) {
    try {
      return new HttpsProxyAgent(url);
    } catch (err) {
      console.warn(`[nanoBananaPro] Неверный прокси URL — пропускаем: ${err.message}`);
    }
  }
  return null;
}

/**
 * generateImage — возвращает { base64, mimeType } первого изображения
 * из ответа Nano Banana Pro. Если API вернул только текст / нулевые
 * изображения — бросаем ошибку.
 *
 * @param {string} prompt
 * @param {object} [opts]
 * @param {string} [opts.negativePrompt]
 * @param {number} [opts.timeoutMs=180000]
 * @returns {Promise<{ base64: string, mimeType: string, model: string }>}
 */
async function generateImage(prompt, opts = {}) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('generateImage: prompt пустой');
  }
  const { negativePrompt = '', timeoutMs = 180000 } = opts;

  const apiKey = requireGeminiApiKey();
  const agent  = buildProxyAgent();
  if (!agent) {
    throw new Error(
      'Nano Banana Pro: прокси не настроен. Задайте один из: ' +
      'LINK_ARTICLE_IMAGE_PROXY_URL / LLM_PROXY_* / GEMINI_PROXY_* (включая запасные _2…_5) ' +
      '/ HTTPS_PROXY в .env. Образец — .env.example.'
    );
  }

  const endpoint = `${GEMINI_BASE_URL}/${IMAGE_MODEL}:generateContent?key=${apiKey}`;

  // Gemini image-модели принимают текстовый prompt + опциональный negative
  // prompt. Формат ответа — inlineData (base64) в parts первого кандидата.
  const finalPrompt = negativePrompt
    ? `${prompt}\n\nAvoid: ${negativePrompt}`
    : prompt;

  const payload = {
    contents: [{
      parts: [{ text: finalPrompt }],
    }],
    generationConfig: {
      // Нано-банана поддерживает несколько модальностей — просим IMAGE + TEXT.
      // (TEXT нужен как fallback для моделей, где чистый image-only не разрешён
      // на данной ревизии API; реально мы берём только inlineData.)
      responseModalities: ['TEXT', 'IMAGE'],
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  let response;
  try {
    response = await axios.post(endpoint, payload, {
      timeout:        timeoutMs,
      headers:        { 'Content-Type': 'application/json' },
      validateStatus: null,
      httpsAgent:     agent,
      proxy:          false,
    });
  } catch (err) {
    throw new Error(`Nano Banana Pro network error: ${err.message}`);
  }

  if (response.status !== 200) {
    const detail = response.data?.error?.message || JSON.stringify(response.data).slice(0, 300);
    throw new Error(`Nano Banana Pro HTTP ${response.status}: ${detail}`);
  }

  const candidate = response.data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];

  let inlineData = null;
  for (const p of parts) {
    if (p?.inlineData?.data && p?.inlineData?.mimeType) {
      inlineData = p.inlineData;
      break;
    }
    // Старая ветка API (legacy) — поле может называться inline_data
    if (p?.inline_data?.data && p?.inline_data?.mime_type) {
      inlineData = { data: p.inline_data.data, mimeType: p.inline_data.mime_type };
      break;
    }
  }

  if (!inlineData) {
    const finishReason = candidate?.finishReason || 'UNKNOWN';
    throw new Error(
      `Nano Banana Pro не вернул изображение (finishReason=${finishReason}). ` +
      `Проверьте, что модель ${IMAGE_MODEL} доступна для вашего API-ключа.`
    );
  }

  // Защита от «raw bomb» — ограничиваем максимальный размер base64.
  if (inlineData.data.length > MAX_IMAGE_BASE64_BYTES) {
    throw new Error(
      `Nano Banana Pro: размер изображения превышает лимит ` +
      `(${inlineData.data.length} > ${MAX_IMAGE_BASE64_BYTES} base64-байт)`
    );
  }

  return {
    base64:   inlineData.data,
    mimeType: inlineData.mimeType || 'image/png',
    model:    IMAGE_MODEL,
  };
}

module.exports = { generateImage, IMAGE_MODEL };
