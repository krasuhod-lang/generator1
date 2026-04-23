'use strict';

/**
 * responseCache — детерминированный кэш «промпт → JSON ответ» в Redis.
 *
 * Цель: экономить деньги при повторных запусках задачи с одним и тем же
 * входом (URL + ключи + параметры). Альтернатива serverside context-cache:
 * работает для всех провайдеров (Gemini / Grok / DeepSeek), и специально
 * полезна для DeepSeek, у которого нет серверного context-cache в стиле
 * OpenAI.
 *
 * Ключ: sha256(adapter | model | system | user | temperature). Раздельные
 * temperature → раздельные ключи (детерминизм). Если temperature не задан —
 * используется строка '_'.
 *
 * Включается флагом env LLM_RESPONSE_CACHE_ENABLED=true. По умолчанию выкл —
 * чтобы не привнести регрессов в существующих окружениях.
 *
 * TTL: 7 дней (LLM_RESPONSE_CACHE_TTL_SECONDS env override).
 *
 * Безопасность: ключ — sha256, в Redis уходит только хэш + JSON-ответ.
 * Сами промпты НЕ хранятся в Redis (только хэшируются).
 */

const crypto = require('crypto');
const Redis  = require('ioredis');

const ENABLED = String(process.env.LLM_RESPONSE_CACHE_ENABLED || '').toLowerCase() === 'true';
const TTL_S   = Math.max(60, parseInt(process.env.LLM_RESPONSE_CACHE_TTL_SECONDS, 10) || 7 * 24 * 3600);
const KEY_PREFIX = 'llmcache:v1:';
// Не кэшируем гигантские объекты — Redis не должен раздуваться от patological-edge cases.
const MAX_VALUE_BYTES = 256 * 1024;

let _redis = null;
let _failed = false;

function _client() {
  if (!ENABLED || _failed) return null;
  if (_redis) return _redis;
  try {
    const url = process.env.REDIS_URL;
    _redis = url
      ? new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false })
      : new Redis({
          host: process.env.REDIS_HOST || 'localhost',
          port: parseInt(process.env.REDIS_PORT, 10) || 6379,
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          enableOfflineQueue: false,
        });
    _redis.on('error', (err) => {
      // Тихо логируем — кэш не должен ронять пайплайн.
      if (!_failed) console.warn('[responseCache] redis error:', err.message);
    });
    _redis.connect().catch((err) => {
      console.warn('[responseCache] redis connect failed (cache disabled for this process):', err.message);
      _failed = true;
    });
    return _redis;
  } catch (e) {
    console.warn('[responseCache] init failed:', e.message);
    _failed = true;
    return null;
  }
}

/**
 * Стабильный ключ для пары (adapter, model, system, user, temperature).
 * Используем sha256 → 64 hex chars, без зависимости от длины промпта.
 */
function buildKey({ adapter, system = '', prompt = '', temperature, maxTokens }) {
  const h = crypto.createHash('sha256');
  // Включаем поля раздельно, чтобы случайная коллизия конкатенации
  // не объединяла разные ключи (например, system без разделителя).
  h.update('A=' + (adapter || ''));
  h.update('|S=' + system);
  h.update('|U=' + prompt);
  h.update('|T=' + (temperature == null ? '_' : String(temperature)));
  h.update('|M=' + (maxTokens   == null ? '_' : String(maxTokens)));
  // model — берём из env (если задан явно), иначе входит в adapter-namespace
  // через сам adapter (gemini.adapter уже содержит GEMINI_MODEL).
  const modelEnv = adapter === 'gemini'   ? process.env.GEMINI_MODEL
                 : adapter === 'grok'     ? process.env.XAI_MODEL
                 : adapter === 'deepseek' ? process.env.DEEPSEEK_MODEL
                 : '';
  h.update('|MD=' + (modelEnv || ''));
  return KEY_PREFIX + h.digest('hex');
}

/**
 * getCachedResponse — проверяет наличие в кэше. Возвращает:
 *   { cached: true,  value, key } — кэш-хит
 *   { cached: false, key }        — кэш-мисс, передайте key в setCachedResponse
 *   null                          — кэш отключён или ошибка (пропускаем)
 */
async function getCachedResponse(args) {
  const cli = _client();
  if (!cli) return null;
  const key = buildKey(args);
  try {
    const raw = await cli.get(key);
    if (!raw) return { cached: false, key };
    return { cached: true, value: JSON.parse(raw), key };
  } catch (e) {
    // get не должен падать пайплайн
    return { cached: false, key };
  }
}

/**
 * setCachedResponse — пишет ответ в кэш. Возвращает true/false (не throw).
 */
async function setCachedResponse(key, value) {
  const cli = _client();
  if (!cli || !key) return false;
  try {
    const json = JSON.stringify(value);
    if (json.length > MAX_VALUE_BYTES) return false;
    await cli.set(key, json, 'EX', TTL_S);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = { getCachedResponse, setCachedResponse, buildKey, ENABLED };
