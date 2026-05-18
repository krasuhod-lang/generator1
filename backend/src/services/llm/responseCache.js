'use strict';

/**
 * responseCache — детерминированный кэш «промпт → JSON ответ» в Redis.
 *
 * Цель: экономить деньги при повторных запусках задачи с одним и тем же
 * входом (URL + ключи + параметры). Альтернатива serverside context-cache:
 * работает для всех провайдеров (Gemini / Grok / DeepSeek / Qwen), и
 * специально полезна для DeepSeek, у которого нет серверного context-cache
 * в стиле OpenAI.
 *
 * Ключ (v2):
 *   sha256(adapter | model | system | user | temperature | maxTokens)
 *   с префиксом `llmcache:v2:b=<sha1(brand)[..16]>:`.
 *
 * Почему v2: в v1 ключ не учитывал бренд → две задачи разных брендов с
 * одинаковым промптом получали один и тот же кэшированный ответ. Это
 * нарушает приватность бренд-чувствительных формулировок (цены, ассортимент,
 * история компании). В v2 префикс зависит от бренда, поэтому изоляция
 * гарантирована, плюс мы можем по этому префиксу делать SCAN/DEL по бренду.
 *
 * TTL: 7 дней (политика в backend/src/services/llm/cachePolicy.js). Старые
 * ENV LLM_RESPONSE_CACHE_TTL_SECONDS продолжает уважаться ради BC, но не
 * требуется и не рекомендуется.
 *
 * Включается флагом env LLM_RESPONSE_CACHE_ENABLED=true. По умолчанию выкл —
 * чтобы не привнести регрессов в существующих окружениях.
 *
 * Безопасность: ключ — sha256, в Redis уходит только хэш + JSON-ответ.
 * Сами промпты НЕ хранятся в Redis (только хэшируются).
 */

const crypto = require('crypto');
const Redis  = require('ioredis');
const { getCachePolicy, normalizeBrand } = require('./cachePolicy');

const POLICY = getCachePolicy();

const ENABLED = String(process.env.LLM_RESPONSE_CACHE_ENABLED || '').toLowerCase() === 'true';
// Дефолт 7 дней из cachePolicy; ENV override сохранён для обратной
// совместимости со старыми деплойментами, но обычно не используется.
const TTL_S   = Math.max(
  60,
  parseInt(process.env.LLM_RESPONSE_CACHE_TTL_SECONDS, 10) || POLICY.ttlSeconds,
);
// v1 → v2: добавлен brand-scoping. Старые v1-ключи дотухнут естественно за 7
// дней и не дадут ложных хитов.
const KEY_PREFIX = 'llmcache:v2:';
// Не кэшируем гигантские объекты — Redis не должен раздуваться от
// patological-edge cases. Берём лимит из единой политики.
const MAX_VALUE_BYTES = POLICY.maxValueBytes;

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
 * Стабильный хэш для бренда, используется как часть Redis-префикса.
 * 16 hex chars (64 бита) достаточно для уникальности бренд-неймспейсов и
 * умещается в человекочитаемых key dumps.
 */
function _brandHash(brand) {
  return crypto.createHash('sha1')
    .update(normalizeBrand(brand))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Стабильный ключ для пары (adapter, model, system, user, temperature, brand).
 * Используем sha256 → 64 hex chars, без зависимости от длины промпта.
 * Префикс ключа содержит хэш бренда — это позволяет делать SCAN/DEL по
 * бренду одной командой Redis MATCH `llmcache:v2:b=<hash>:*`.
 */
function buildKey({ adapter, system = '', prompt = '', temperature, maxTokens, brand = '' }) {
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
  // Бренд в hash тоже включаем, на случай если префикс изменится в будущем
  // и понадобится миграция: значение ключа всё равно уникально per-brand.
  h.update('|B=' + normalizeBrand(brand));
  const brandPart = POLICY.brandInKey ? `b=${_brandHash(brand)}:` : '';
  return KEY_PREFIX + brandPart + h.digest('hex');
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

/**
 * Сканирует Redis и возвращает массив ключей, принадлежащих бренду.
 * Использует SCAN (а не KEYS) — безопасно для production-Redis.
 *
 * @param {string} brand — название бренда (из task.brand / brand_name).
 * @returns {Promise<string[]>} — список найденных ключей (может быть пустым).
 */
async function listKeysByBrand(brand) {
  const cli = _client();
  if (!cli) return [];
  const pattern = `${KEY_PREFIX}b=${_brandHash(brand)}:*`;
  const keys = [];
  try {
    let cursor = '0';
    do {
      const [next, batch] = await cli.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const k of batch) keys.push(k);
    } while (cursor !== '0');
    return keys;
  } catch (e) {
    console.warn(`[responseCache] listKeysByBrand failed: ${e.message}`);
    return [];
  }
}

/**
 * Удаляет все ключи указанного бренда из Redis.
 * Возвращает количество удалённых ключей (0 при ошибке/отсутствии).
 */
async function invalidateByBrand(brand) {
  const cli = _client();
  if (!cli) return 0;
  const keys = await listKeysByBrand(brand);
  if (!keys.length) return 0;
  try {
    // Удаляем батчами по 200, чтобы не отправлять гигантскую UNLINK-команду.
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      // UNLINK неблокирующий; fallback на DEL для совместимости со старым Redis.
      const n = (await (cli.unlink ? cli.unlink(...chunk) : cli.del(...chunk))) || 0;
      deleted += Number(n) || 0;
    }
    return deleted;
  } catch (e) {
    console.warn(`[responseCache] invalidateByBrand failed: ${e.message}`);
    return 0;
  }
}

/**
 * Возвращает агрегированную статистику кэша в разрезе брендов:
 *   [{ brandHash, keys, bytes }, ...] — отсортирован по keys убывающе.
 *
 * Используется в админ-панели «Кэш по брендам». На больших Redis (>10k ключей)
 * может быть медленным; в этом случае имеет смысл вызывать редко (раз в минуту).
 */
async function getCacheStatsByBrand() {
  const cli = _client();
  if (!cli) return [];
  const pattern = `${KEY_PREFIX}b=*`;
  const byHash = new Map(); // brandHash → { keys, bytes }
  try {
    let cursor = '0';
    do {
      const [next, batch] = await cli.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      for (const k of batch) {
        // Ключ вида llmcache:v2:b=<16hex>:<sha256>. Достаём brandHash.
        const m = k.match(/^llmcache:v2:b=([0-9a-f]{16}):/);
        if (!m) continue;
        const bh = m[1];
        if (!byHash.has(bh)) byHash.set(bh, { brandHash: bh, keys: 0, bytes: 0 });
        const entry = byHash.get(bh);
        entry.keys += 1;
        try {
          const sz = await cli.strlen(k);
          entry.bytes += Number(sz) || 0;
        } catch (_) { /* skip strlen errors */ }
      }
    } while (cursor !== '0');
    return Array.from(byHash.values()).sort((a, b) => b.keys - a.keys);
  } catch (e) {
    console.warn(`[responseCache] getCacheStatsByBrand failed: ${e.message}`);
    return [];
  }
}

module.exports = {
  getCachedResponse,
  setCachedResponse,
  buildKey,
  ENABLED,
  TTL_S,
  KEY_PREFIX,
  // Brand-aware утилиты:
  listKeysByBrand,
  invalidateByBrand,
  getCacheStatsByBrand,
  _brandHash, // экспортируем для тестов
};
