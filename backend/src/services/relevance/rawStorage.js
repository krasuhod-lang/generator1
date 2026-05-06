'use strict';

/**
 * rawStorage — Redis-сторадж для processed-документов отчёта релевантности.
 *
 * Зачем:
 *   PR 2 (семантические коконы) требует повторного прогона уже распарсенных
 *   документов через TruncatedSVD — но мы не хотим парсить ТОП-20 заново
 *   и не хотим раздувать Postgres. Поэтому после первого /analyze
 *   processed_documents (леммы + POS-последовательности) лежат в Redis
 *   с TTL 7 дней (по ключу `relevance:raw:{report_id}`), а агрегаты —
 *   в Postgres навсегда. Истекли 7 дней — пользователь увидит «кэш истёк»
 *   и не сможет пересчитать коконы (потребуется новый /analyze).
 *
 * Ключи env:
 *   REDIS_URL          (общий с responseCache.js / sseManager.js)
 *   REDIS_HOST/PORT/PASSWORD (fallback при отсутствии REDIS_URL)
 *   RELEVANCE_RAW_TTL_SECONDS (default 604800 = 7d)
 *   RELEVANCE_RAW_MAX_BYTES   (default 16 MiB — защита от patological-edge)
 *
 * Если Redis недоступен — все методы возвращают null/false без exceptions
 * (graceful degradation: пайплайн не падает, просто PR 2-фичи недоступны
 * для этого отчёта).
 */

const Redis = require('ioredis');

const KEY_PREFIX = 'relevance:raw:v1:';

const TTL_SECONDS = (() => {
  const v = parseInt(process.env.RELEVANCE_RAW_TTL_SECONDS, 10);
  // Минимум 1 час, максимум 30 дней. Default — 7 дней.
  return Number.isFinite(v) && v >= 3600 && v <= 30 * 24 * 3600
    ? v
    : 7 * 24 * 3600;
})();

const MAX_BYTES = (() => {
  const v = parseInt(process.env.RELEVANCE_RAW_MAX_BYTES, 10);
  return Number.isFinite(v) && v >= 1024 * 1024 ? v : 16 * 1024 * 1024;
})();

let _redis = null;
let _failed = false;

function _client() {
  if (_failed) return null;
  if (_redis) return _redis;
  try {
    const url = process.env.REDIS_URL;
    _redis = url
      ? new Redis(url, { maxRetriesPerRequest: 1, lazyConnect: true, enableOfflineQueue: false })
      : new Redis({
          host:     process.env.REDIS_HOST || 'localhost',
          port:     parseInt(process.env.REDIS_PORT, 10) || 6379,
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: 1,
          lazyConnect: true,
          enableOfflineQueue: false,
        });
    _redis.on('error', (err) => {
      // Тихо логируем — сторадж не должен ронять пайплайн.
      if (!_failed) console.warn('[relevance/rawStorage] redis error:', err.message);
    });
    _redis.connect().catch((err) => {
      console.warn('[relevance/rawStorage] redis connect failed (raw cache disabled):', err.message);
      _failed = true;
    });
    return _redis;
  } catch (e) {
    console.warn('[relevance/rawStorage] init failed:', e.message);
    _failed = true;
    return null;
  }
}

function _key(reportId) {
  return KEY_PREFIX + String(reportId);
}

/**
 * Сохранить processed-документы.
 * @param {string|number} reportId
 * @param {Array<object>} processedDocs — массив из Python-сервиса
 *        (return_processed=true), каждый: {url, lemmas, pos_seq}.
 * @returns {Promise<{stored:boolean, expiresAt:Date|null, sizeBytes:number}>}
 */
async function saveRaw(reportId, processedDocs) {
  if (!reportId || !Array.isArray(processedDocs) || processedDocs.length === 0) {
    return { stored: false, expiresAt: null, sizeBytes: 0 };
  }
  const cli = _client();
  if (!cli) return { stored: false, expiresAt: null, sizeBytes: 0 };

  let payload;
  try {
    payload = JSON.stringify(processedDocs);
  } catch (e) {
    console.warn('[relevance/rawStorage] saveRaw: JSON.stringify failed:', e.message);
    return { stored: false, expiresAt: null, sizeBytes: 0 };
  }
  const sizeBytes = Buffer.byteLength(payload, 'utf8');
  if (sizeBytes > MAX_BYTES) {
    console.warn(
      '[relevance/rawStorage] saveRaw: payload too large (%d > %d), skipping',
      sizeBytes, MAX_BYTES,
    );
    return { stored: false, expiresAt: null, sizeBytes };
  }

  try {
    await cli.set(_key(reportId), payload, 'EX', TTL_SECONDS);
    return {
      stored:    true,
      expiresAt: new Date(Date.now() + TTL_SECONDS * 1000),
      sizeBytes,
    };
  } catch (e) {
    console.warn('[relevance/rawStorage] saveRaw failed:', e.message);
    return { stored: false, expiresAt: null, sizeBytes };
  }
}

/**
 * Загрузить processed-документы. Возвращает null, если ключа нет / Redis недоступен.
 * @returns {Promise<Array<object>|null>}
 */
async function loadRaw(reportId) {
  if (!reportId) return null;
  const cli = _client();
  if (!cli) return null;
  try {
    const raw = await cli.get(_key(reportId));
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[relevance/rawStorage] loadRaw failed:', e.message);
    return null;
  }
}

/**
 * Удалить processed-документы досрочно (например, по запросу пользователя).
 * @returns {Promise<boolean>} — true, если ключ был удалён; false иначе.
 */
async function deleteRaw(reportId) {
  if (!reportId) return false;
  const cli = _client();
  if (!cli) return false;
  try {
    const removed = await cli.del(_key(reportId));
    return removed > 0;
  } catch (e) {
    console.warn('[relevance/rawStorage] deleteRaw failed:', e.message);
    return false;
  }
}

/**
 * Проверить, существует ли ключ + получить TTL (в секундах).
 * @returns {Promise<{exists:boolean, ttlSeconds:number}>}
 */
async function statRaw(reportId) {
  if (!reportId) return { exists: false, ttlSeconds: -2 };
  const cli = _client();
  if (!cli) return { exists: false, ttlSeconds: -2 };
  try {
    const ttl = await cli.ttl(_key(reportId));
    // -2 = ключа нет, -1 = ключ есть, но без TTL (не должен случиться).
    return { exists: ttl >= -1 && ttl !== -2, ttlSeconds: ttl };
  } catch (e) {
    console.warn('[relevance/rawStorage] statRaw failed:', e.message);
    return { exists: false, ttlSeconds: -2 };
  }
}

module.exports = {
  saveRaw,
  loadRaw,
  deleteRaw,
  statRaw,
  TTL_SECONDS,
  MAX_BYTES,
};
