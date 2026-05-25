'use strict';

/**
 * cachePolicy — единая, замороженная политика кэширования контента.
 *
 * Зачем отдельный модуль:
 *   - Срок хранения, размеры значений и интервал sweeper'а — продуктовое
 *     решение, а не инфраструктурная константа per-file. Один источник
 *     правды на весь backend (responseCache, serpEvidence и т.п.).
 *   - По требованию заказчика новые ENV-переменные не добавляются. Все
 *     умолчания фиксируем здесь, в коде. Существующие ENV
 *     (LLM_RESPONSE_CACHE_TTL_SECONDS) продолжают перебивать дефолт ради
 *     обратной совместимости, но рекомендуется их не задавать.
 *   - deepFreeze гарантирует, что чужой код не сможет случайно изменить
 *     политику в рантайме (типичная ошибка — мутировать default-объект).
 *
 * Используется:
 *   - backend/src/services/llm/responseCache.js (TTL по умолчанию = 7 дней,
 *     максимальный размер сериализованного значения + admission-control для
 *     больших one-off SEO-промптов).
 *   - backend/src/services/infoArticle/serpEvidence.service.js (TTL
 *     in-memory кэша SERP-evidence + sweeper interval).
 */

const SECONDS_PER_DAY = 24 * 60 * 60;

const DEFAULTS = {
  // Срок хранения данных в кэше. По задаче: 7 дней, после чего автоматически
  // затирается. Redis TTL делает это сам через SET ... EX; in-memory sweeper
  // обходит Map и удаляет просроченные записи.
  ttlSeconds: 7 * SECONDS_PER_DAY,
  // Лимит размера сериализованного JSON-значения, защищающий Redis от
  // патологически больших ответов (одна задача с 2 МБ HTML может надуть кэш).
  maxValueBytes: 256 * 1024,
  // Не пишем в Redis response-cache огромные one-off SEO-промпты: они почти
  // никогда не дают точный повторный hit, но быстро заполняют хранилище.
  // Это не влияет на качество генерации — меняется только решение «кэшировать
  // ли уже полученный ответ».
  maxKeyMaterialBytes: 96 * 1024,
  // Период фонового sweeper'а для in-memory кэшей. 5 минут — компромисс
  // между точностью истечения и стоимостью прохода по Map.
  sweepIntervalMs: 5 * 60 * 1000,
  // Включать ли изоляцию по бренду в ключе кэша. По задаче: ДА, так как
  // две задачи разных брендов с похожими промптами не должны видеть ответы
  // друг друга (бренд-чувствительные факты, цены, формулировки).
  brandInKey: true,
};

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
    Object.freeze(obj);
  }
  return obj;
}

const FROZEN = deepFreeze({ ...DEFAULTS });

/**
 * @returns {Readonly<typeof DEFAULTS>}
 */
function getCachePolicy() {
  return FROZEN;
}

/**
 * Нормализованный «бренд-ключ» для использования в составных Redis-ключах.
 * Тримим, lowercase. Пустой бренд → 'nobrand', чтобы все ключи без явного
 * бренда жили в одном пространстве (не размазывались по дефолтам).
 */
function normalizeBrand(brand) {
  const s = String(brand == null ? '' : brand).trim().toLowerCase();
  return s || 'nobrand';
}

function _byteLen(v) {
  return Buffer.byteLength(String(v == null ? '' : v), 'utf8');
}

/**
 * shouldCacheResponse — единая admission-политика для Redis response-cache.
 * Возвращает { ok, reason } вместо boolean, чтобы логи/тесты могли объяснить
 * пропуск без догадок.
 */
function shouldCacheResponse({ adapter = '', system = '', prompt = '', value = undefined } = {}) {
  const provider = String(adapter || '').toLowerCase();
  if (!['deepseek', 'gemini', 'grok'].includes(provider)) {
    return { ok: false, reason: 'unsupported_adapter' };
  }

  const keyMaterialBytes = _byteLen(system) + _byteLen(prompt);
  if (keyMaterialBytes > FROZEN.maxKeyMaterialBytes) {
    return { ok: false, reason: 'prompt_too_large', keyMaterialBytes };
  }

  if (value !== undefined) {
    let json = '';
    try { json = JSON.stringify(value); }
    catch (_) { return { ok: false, reason: 'value_not_json' }; }
    const valueBytes = Buffer.byteLength(json || '', 'utf8');
    if (valueBytes > FROZEN.maxValueBytes) {
      return { ok: false, reason: 'value_too_large', valueBytes };
    }
  }

  return { ok: true, reason: 'ok', keyMaterialBytes };
}

module.exports = { getCachePolicy, normalizeBrand, shouldCacheResponse };
