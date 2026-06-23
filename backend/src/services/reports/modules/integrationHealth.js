'use strict';

/**
 * reports/modules/integrationHealth.js
 *
 * Спецификация ТЗ требует «fail-counter + авто-деактивацию после 3 ошибок
 * подряд» вокруг синхронизаций интеграций (GSC / Яндекс.Вебмастер / Keys.so).
 *
 * Здесь — чистая, тестируемая машина состояний, которую schedulers/sync-функции
 * вызывают после каждой попытки синхронизации. Персистентность (колонки
 * fail_count / is_active / last_synced_at в таблице интеграций) оставлена на
 * вызывающую сторону, чтобы хелпер не был привязан к конкретной схеме БД.
 *
 *   nextHealth(state, outcome, opts) → { fail_count, is_active, deactivated, ... }
 */

const DEFAULT_FAIL_THRESHOLD = 3;

function _int(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : def;
}

/**
 * Вычислить новое состояние здоровья интеграции после одной попытки синка.
 *
 * @param {object} state   текущее состояние { fail_count, is_active }
 * @param {'success'|'failure'} outcome  исход последней попытки
 * @param {object} opts    { threshold=3, now=Date, reason }
 * @returns {object} новое состояние
 */
function nextHealth(state = {}, outcome = 'success', opts = {}) {
  const threshold = _int(opts.threshold, DEFAULT_FAIL_THRESHOLD) || DEFAULT_FAIL_THRESHOLD;
  const now = opts.now instanceof Date ? opts.now : new Date();
  const prevFails = _int(state.fail_count, 0);
  // Если is_active не задан явно — считаем интеграцию активной.
  const prevActive = state.is_active === undefined ? true : !!state.is_active;

  if (outcome === 'success') {
    return {
      fail_count: 0,
      is_active: prevActive,
      deactivated: false,
      reactivated: false,
      last_synced_at: now,
      last_error: null,
    };
  }

  // outcome === 'failure'
  const failCount = prevFails + 1;
  const shouldDeactivate = prevActive && failCount >= threshold;
  return {
    fail_count: failCount,
    is_active: shouldDeactivate ? false : prevActive,
    deactivated: shouldDeactivate,
    reactivated: false,
    last_synced_at: state.last_synced_at || null,
    last_error: opts.reason ? String(opts.reason).slice(0, 500) : (state.last_error || null),
  };
}

/**
 * Принудительная ре-активация интеграции (например, после обновления токена).
 * Сбрасывает счётчик ошибок.
 */
function reactivate(state = {}) {
  return {
    fail_count: 0,
    is_active: true,
    deactivated: false,
    reactivated: state.is_active === false,
    last_synced_at: state.last_synced_at || null,
    last_error: null,
  };
}

module.exports = { nextHealth, reactivate, DEFAULT_FAIL_THRESHOLD };
