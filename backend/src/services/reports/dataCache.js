'use strict';

/**
 * In-memory TTL cache for «тяжёлые» секции отчётов (GSC / Яндекс.Вебмастер /
 * Keys.so / съём позиций / топ-запросы). Решает основной источник
 * `timeout of 60000ms exceeded` на `/api/reports/drafts/:id/data`: один и тот
 * же агрегат дёргается несколько раз подряд (открытие черновика, генерация
 * AI-summary, экспорт PDF/DOCX, опрос статуса) — каждый раз поход в GSC API
 * мог занимать 20-40s.
 *
 * Принципы:
 *   • TTL по умолчанию 5 минут (env REPORTS_DATA_CACHE_TTL_MS).
 *   • Хранится сам Promise — параллельные вызовы дедуплицируются (важно для
 *     случая «фронт открывает отчёт» + «AI-summary стартует в фоне» сразу).
 *   • Кэш сбрасывается при ошибке выполнения — повторный запрос пойдёт за
 *     новыми данными, а не за rejected-promise.
 *   • Ограничение размера (LRU-eviction по порядку вставки в Map).
 *   • Полная инвалидация по префиксу — используется при изменении конфига
 *     черновика или ручном `?refresh=1`.
 *
 * Это НЕ замена sourceConsentLog / freshnessService — те хранят последний
 * успешный sync в БД. Здесь чисто кэш read-through агрегата на время одной
 * сессии работы с отчётом.
 */

const TTL_MS = Math.max(0, Number(process.env.REPORTS_DATA_CACHE_TTL_MS) || 5 * 60 * 1000);
const MAX_ENTRIES = Math.max(8, Number(process.env.REPORTS_DATA_CACHE_MAX) || 256);

// key -> { promise, expires }
const cache = new Map();

function _now() { return Date.now(); }

function _evictExpired() {
  if (cache.size <= MAX_ENTRIES) return;
  // Map сохраняет порядок вставки — удаляем самые старые.
  const overflow = cache.size - MAX_ENTRIES;
  let i = 0;
  for (const key of cache.keys()) {
    if (i >= overflow) break;
    cache.delete(key);
    i += 1;
  }
}

function makeKey(parts) {
  // Сериализация частей в стабильную строку; объекты — через JSON-stringify
  // с сортировкой ключей (детерминированный хэш конфигов / overrides).
  return parts.map((p) => {
    if (p == null) return '';
    if (typeof p === 'object') return _stableStringify(p);
    return String(p);
  }).join('|');
}

function _stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(_stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ':' + _stableStringify(value[k])).join(',')}}`;
}

/**
 * Read-through cache: если в кэше есть свежий promise — возвращаем его,
 * иначе вызываем `loader()` и кладём результат с TTL.
 *
 * При reject — запись удаляется (чтобы не «залипал» провал внешнего API).
 */
function cached(key, loader, ttlMs = TTL_MS) {
  if (!ttlMs || ttlMs <= 0) return Promise.resolve().then(loader);
  const hit = cache.get(key);
  if (hit && hit.expires > _now()) {
    return hit.promise;
  }
  if (hit) cache.delete(key);

  const promise = Promise.resolve().then(loader);
  cache.set(key, { promise, expires: _now() + ttlMs });
  _evictExpired();

  promise.catch(() => {
    const cur = cache.get(key);
    if (cur && cur.promise === promise) cache.delete(key);
  });
  return promise;
}

/**
 * Удаляет все записи, ключ которых начинается на `prefix`.
 * Возвращает число удалённых.
 */
function invalidatePrefix(prefix) {
  if (!prefix) return 0;
  let n = 0;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) { cache.delete(key); n += 1; }
  }
  return n;
}

function clear() { cache.clear(); }

function size() { return cache.size; }

module.exports = {
  cached,
  makeKey,
  invalidatePrefix,
  clear,
  size,
  TTL_MS,
};
