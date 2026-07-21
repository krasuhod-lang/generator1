'use strict';

/**
 * semanticFactcheckPolicy — политика fail-open / fail-closed для семантического
 * фактчекинга (Итерация 2, Задача 3).
 *
 * Текущее поведение семантической верификации (factCheck.service.js) —
 * fail-open: если DeepSeek недоступен / таймаут / невалидный ответ, статья
 * всё равно проходит (semantic просто помечается skipped). Для YMYL-ниш
 * (медицина, финансы, юриспруденция, страхование, безопасность) это риск.
 *
 * Модуль вводит режим FACTCHECK_FAIL_MODE:
 *   • open        (default) — как сейчас: недоступность семантики → warning;
 *   • closed_ymyl —          для YMYL-ниш недоступность → blocker + ретраи;
 *   • closed_all  —          для любой ниши недоступность → blocker + ретраи.
 *
 * При fail-closed статья получает blocker `semantic_factcheck_unavailable`,
 * уходит в очередь ретраев (3 попытки с задержкой 1 / 5 / 15 минут), а после
 * исчерпания — в ручную модерацию. Каждый случай fail-closed фиксируется в
 * процессном счётчике метрик (ниша + причина) для мониторинга доли блокировок.
 *
 * Модуль чистый: без БД и без сети. Единственный побочный эффект — процессный
 * счётчик метрик (recordFailClosed / getFailClosedMetrics / resetFailClosedMetrics).
 */

const contentPolicy = require('../contentPolicy');

// ── Режимы fail-mode ──────────────────────────────────────────────────
const FAIL_MODES = Object.freeze(['open', 'closed_ymyl', 'closed_all']);
const DEFAULT_FAIL_MODE = 'open';

/**
 * resolveFailMode — нормализовать режим: явный override > env FACTCHECK_FAIL_MODE
 * > default 'open'. Неизвестные значения → 'open' (безопасный fail-open).
 * @param {string} [override]
 * @returns {'open'|'closed_ymyl'|'closed_all'}
 */
function resolveFailMode(override) {
  const raw = String(override != null ? override : (process.env.FACTCHECK_FAIL_MODE || ''))
    .trim()
    .toLowerCase();
  return FAIL_MODES.includes(raw) ? raw : DEFAULT_FAIL_MODE;
}

/**
 * shouldFailClosed — нужно ли блокировать при недоступной семантике.
 * @param {object} params
 * @param {string}  params.failMode — 'open' | 'closed_ymyl' | 'closed_all'
 * @param {boolean} params.isYmyl   — принадлежит ли ниша YMYL
 * @returns {boolean}
 */
function shouldFailClosed({ failMode, isYmyl } = {}) {
  const mode = resolveFailMode(failMode);
  if (mode === 'closed_all') return true;
  if (mode === 'closed_ymyl') return !!isYmyl;
  return false;
}

/**
 * isYmylNiche — тонкая обёртка над contentPolicy (список YMYL-ниш вынесен в
 * конфиг contentPolicy/defaults.js → DEFAULT_YMYL_KEYWORDS и расширяется через
 * таблицу content_policy_rules без деплоя).
 * @param {string} niche
 * @returns {boolean}
 */
function isYmylNiche(niche) {
  return contentPolicy.isYmylNiche(niche || '');
}

// ── Расписание ретраев ────────────────────────────────────────────────
// Экспоненциальная задержка 1 / 5 / 15 минут, всего 3 попытки; после
// исчерпания — ручная модерация.
const RETRY_DELAYS_MS = Object.freeze([60000, 300000, 900000]);
const MAX_RETRIES = RETRY_DELAYS_MS.length;

/**
 * planRetry — рассчитать следующий шаг ретрая по номеру попытки (1-based).
 *   attempt 1 → delay 60000мс   (1 мин),  action 'retry'
 *   attempt 2 → delay 300000мс  (5 мин),  action 'retry'
 *   attempt 3 → delay 900000мс  (15 мин), action 'retry' (isFinal)
 *   attempt >3 → delay null, action 'manual_moderation'
 * @param {number} attempt — номер попытки, начиная с 1
 * @returns {{ attempt:number, delayMs:number|null, isFinal:boolean, action:'retry'|'manual_moderation' }}
 */
function planRetry(attempt) {
  const n = Number(attempt);
  if (!Number.isFinite(n) || n < 1) {
    return { attempt: 1, delayMs: RETRY_DELAYS_MS[0], isFinal: MAX_RETRIES === 1, action: 'retry' };
  }
  if (n > MAX_RETRIES) {
    return { attempt: n, delayMs: null, isFinal: true, action: 'manual_moderation' };
  }
  return {
    attempt: n,
    delayMs: RETRY_DELAYS_MS[n - 1],
    isFinal: n >= MAX_RETRIES,
    action: 'retry',
  };
}

/**
 * retrySchedule — полное расписание задержек ретраев (для логов/тестов/UI).
 * @returns {number[]} копия RETRY_DELAYS_MS
 */
function retrySchedule() {
  return RETRY_DELAYS_MS.slice();
}

/**
 * orchestrateRetries — прогнать до MAX_RETRIES попыток семантической
 * верификации по расписанию 1/5/15 минут; после исчерпания — ручная модерация.
 *
 * Функция чистая по зависимостям: все побочные эффекты инъектируются, что
 * делает её тестируемой без сети/Redis/таймеров (передайте sleep=async no-op).
 *
 * @param {object} params
 * @param {function(): Promise<{ok:boolean, reason?:string}>} params.verify —
 *   повторная семантическая верификация; ok:true = успех, ретраи прекращаются.
 * @param {function(object): (void|Promise<void>)} [params.onScheduleRetry] —
 *   вызывается перед каждой попыткой с объектом planRetry (для enqueue/лога).
 * @param {function(object): (void|Promise<void>)} [params.onManualModeration] —
 *   вызывается один раз после исчерпания попыток (перевод в ручную модерацию).
 * @param {function(number): Promise<void>} [params.sleep] — ожидание задержки;
 *   по умолчанию реальный setTimeout. В тестах передайте no-op.
 * @returns {Promise<{resolved:boolean, attempts:number, action?:string, reason?:string}>}
 */
async function orchestrateRetries({ verify, onScheduleRetry, onManualModeration, sleep } = {}) {
  if (typeof verify !== 'function') {
    throw new TypeError('orchestrateRetries: verify() function is required');
  }
  const wait = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let lastReason = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const plan = planRetry(attempt);
    if (typeof onScheduleRetry === 'function') await onScheduleRetry(plan);
    if (plan.delayMs != null) await wait(plan.delayMs);
    let res;
    try {
      res = await verify();
    } catch (err) {
      res = { ok: false, reason: err && err.message ? err.message : String(err) };
    }
    if (res && res.ok) {
      return { resolved: true, attempts: attempt };
    }
    lastReason = (res && res.reason) || lastReason;
  }

  const finalPlan = planRetry(MAX_RETRIES + 1); // action: 'manual_moderation'
  if (typeof onManualModeration === 'function') {
    await onManualModeration({ ...finalPlan, reason: lastReason });
  }
  return { resolved: false, attempts: MAX_RETRIES, action: 'manual_moderation', reason: lastReason };
}

// ── Метрики fail-closed ───────────────────────────────────────────────
// Процессный счётчик: общий total, по нишам и по причинам. Позволяет
// мониторить долю блокировок без внешней зависимости; при желании его можно
// экспортировать в Prometheus/лог-агрегатор.
let _metrics = _emptyMetrics();

function _emptyMetrics() {
  return { total: 0, byNiche: {}, byReason: {} };
}

/**
 * recordFailClosed — зафиксировать один случай fail-closed блокировки.
 * @param {object} params
 * @param {string} [params.niche]  — ниша (для группировки)
 * @param {string} [params.reason] — причина недоступности семантики
 * @returns {object} снимок метрик после инкремента
 */
function recordFailClosed({ niche, reason } = {}) {
  const nicheKey = String(niche || 'unknown').slice(0, 120);
  const reasonKey = String(reason || 'unknown').slice(0, 200);
  _metrics.total += 1;
  _metrics.byNiche[nicheKey] = (_metrics.byNiche[nicheKey] || 0) + 1;
  _metrics.byReason[reasonKey] = (_metrics.byReason[reasonKey] || 0) + 1;
  return getFailClosedMetrics();
}

/** @returns {object} снимок процессных метрик fail-closed */
function getFailClosedMetrics() {
  return {
    total: _metrics.total,
    byNiche: { ..._metrics.byNiche },
    byReason: { ..._metrics.byReason },
  };
}

/** Сбросить счётчики (для тестов). */
function resetFailClosedMetrics() {
  _metrics = _emptyMetrics();
}

module.exports = {
  FAIL_MODES,
  DEFAULT_FAIL_MODE,
  RETRY_DELAYS_MS,
  MAX_RETRIES,
  resolveFailMode,
  shouldFailClosed,
  isYmylNiche,
  planRetry,
  retrySchedule,
  orchestrateRetries,
  recordFailClosed,
  getFailClosedMetrics,
  resetFailClosedMetrics,
};
