'use strict';

/**
 * projects/signalCache.js — универсальный кэш детерминированных срезов анализа
 * GSC (commercial, breakdowns, page_decay, link_audit, eat, schema, geo_aeo…).
 *
 * Зачем (п.6 ТЗ — «усложнить логику получения / кэширования информации для
 * получения точных рекомендаций основанных на статистике»):
 *   • дорогие срезы (парсинг страниц, SERP-пробы, тяжёлые GSC-выгрузки) считаем
 *     один раз и переиспользуем, пока входные данные не изменились;
 *   • ключ кэша = signal_key + hash(детерминированный fingerprint входа), так
 *     что повторный анализ за тот же период не дёргает GSC/парсер/LLM заново;
 *   • re-run отдельных модулей анализа становится дешёвым → аналитику можно
 *     вызывать чаще без расхода токенов/лимитов.
 *
 * Хранилище: таблица project_signal_cache (миграция 066). Все функции
 * принимают `db` извне (тестируемость). Полностью graceful — при любой ошибке
 * чтения/записи возвращает null/no-op, вызывающий код считает срез заново.
 */

const crypto = require('crypto');
const dbDefault = require('../../config/db');
const { getProjectsConfig } = require('./config');

/**
 * Детерминированный fingerprint произвольного входа: стабильная сериализация
 * (ключи объектов сортируются) → sha256. Одинаковый вход → одинаковый hash.
 * @param {*} input
 * @returns {string} hex sha256
 */
function computeHash(input) {
  const json = _stableStringify(input);
  return crypto.createHash('sha256').update(json).digest('hex');
}

function _stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(_stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${_stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Прочитать срез из кэша, если он есть, hash совпал и TTL не истёк.
 * @returns {Promise<{payload:object, computed_at:string, hit:true}|null>}
 */
async function readSignal({ projectId, signalKey, hash }, db = dbDefault) {
  const cfg = getProjectsConfig().signalCache;
  if (!cfg.enabled || !projectId || !signalKey || !hash) return null;
  try {
    const { rows } = await db.query(
      `SELECT payload, computed_at, ttl_sec
         FROM project_signal_cache
        WHERE project_id = $1 AND signal_key = $2 AND hash = $3`,
      [projectId, signalKey, hash],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    const ageSec = (Date.now() - new Date(row.computed_at).getTime()) / 1000;
    if (ageSec > (Number(row.ttl_sec) || cfg.defaultTtlSec)) return null;
    return { payload: row.payload, computed_at: row.computed_at, hit: true };
  } catch (_) {
    return null;
  }
}

/**
 * Записать срез в кэш (upsert по project_id+signal_key). Перезаписывает старый
 * срез того же signalKey (один актуальный срез на ключ).
 */
async function writeSignal({ projectId, signalKey, hash, payload, ttlSec }, db = dbDefault) {
  const cfg = getProjectsConfig().signalCache;
  if (!cfg.enabled || !projectId || !signalKey || !hash) return { ok: false };
  try {
    const json = JSON.stringify(payload == null ? null : payload);
    if (json.length > cfg.maxPayloadBytes) return { ok: false, reason: 'payload_too_large' };
    await db.query(
      `INSERT INTO project_signal_cache
         (project_id, signal_key, hash, payload, ttl_sec, computed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (project_id, signal_key)
       DO UPDATE SET hash = EXCLUDED.hash,
                     payload = EXCLUDED.payload,
                     ttl_sec = EXCLUDED.ttl_sec,
                     computed_at = NOW()`,
      [projectId, signalKey, hash, json, Number(ttlSec) || cfg.defaultTtlSec],
    );
    return { ok: true };
  } catch (_) {
    return { ok: false };
  }
}

/**
 * Высокоуровневая обёртка «get-or-compute»: возвращает закэшированный срез или
 * вычисляет его через computeFn, записывает в кэш и помечает источник.
 *
 * @param {object} args
 * @param {string} args.projectId
 * @param {string} args.signalKey   — логический ключ среза (напр. 'eat', 'schema')
 * @param {*}      args.fingerprint — детерминированный вход, по которому строится hash
 * @param {number} [args.ttlSec]
 * @param {Function} args.computeFn — async () => payload (вызывается при промахе)
 * @param {object} [db]
 * @returns {Promise<{payload:*, cached:boolean}>}
 */
async function getOrCompute({ projectId, signalKey, fingerprint, ttlSec, computeFn }, db = dbDefault) {
  const cfg = getProjectsConfig().signalCache;
  const hash = computeHash({ signalKey, fingerprint });
  if (cfg.enabled && projectId) {
    const cachedRow = await readSignal({ projectId, signalKey, hash }, db);
    if (cachedRow) return { payload: cachedRow.payload, cached: true };
  }
  const payload = await computeFn();
  if (cfg.enabled && projectId && payload != null) {
    await writeSignal({ projectId, signalKey, hash, payload, ttlSec }, db);
  }
  return { payload, cached: false };
}

module.exports = { computeHash, readSignal, writeSignal, getOrCompute };
