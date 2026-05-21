'use strict';

/**
 * aegis/killSwitch — глобальный «красный рычаг» остановки.
 *
 * Когда включён:
 *   - llmRouter возвращает { ok:false, reason:'killswitch' } БЕЗ вызова сети;
 *   - orchestrator не запускает новые итерации refine;
 *   - rayClient.submit() возвращает { ok:false, reason:'killswitch' };
 *   - metrics gauge aegis_killswitch = 1.
 *
 * Состояние persist'ится в aegis_killswitch (миграция 043). Поднимается
 * при старте (loadInitialState). Меняется через POST /api/aegis/kill (admin).
 *
 * In-memory state — primary source of truth для hot-path (нулевой
 * cost проверки). БД — для restart-safety.
 */

const { getAegisFlags } = require('./featureFlags');
const { M: metrics } = require('./telemetry');

const _state = {
  engaged: false,
  reason:  null,
  setBy:   null,
  setAt:   null,
  loaded:  false,
};

function isEngaged() {
  return _state.engaged === true;
}

function snapshot() {
  return {
    engaged: _state.engaged,
    reason:  _state.reason,
    set_by:  _state.setBy,
    set_at:  _state.setAt,
    loaded:  _state.loaded,
  };
}

/**
 * engage({ reason, setBy, db? }) — включить kill switch.
 * Persist в БД делается best-effort (если db указан).
 */
async function engage({ reason, setBy, db = null } = {}) {
  _state.engaged = true;
  _state.reason  = String(reason || 'manual');
  _state.setBy   = String(setBy  || 'system');
  _state.setAt   = new Date().toISOString();
  metrics.killswitch.set(1);
  if (db) {
    try {
      await db.query(
        `INSERT INTO aegis_killswitch (engaged, reason, set_by, set_at)
         VALUES (true, $1, $2, NOW())`,
        [_state.reason, _state.setBy],
      );
    } catch (_e) { /* table may not exist yet */ }
  }
  return snapshot();
}

/** disengage({ setBy, db? }) — выключить kill switch. */
async function disengage({ setBy, db = null } = {}) {
  _state.engaged = false;
  _state.reason  = null;
  _state.setBy   = String(setBy || 'system');
  _state.setAt   = new Date().toISOString();
  metrics.killswitch.set(0);
  if (db) {
    try {
      await db.query(
        `INSERT INTO aegis_killswitch (engaged, reason, set_by, set_at)
         VALUES (false, $1, $2, NOW())`,
        ['disengaged', _state.setBy],
      );
    } catch (_e) { /* ignore */ }
  }
  return snapshot();
}

/** loadInitialState(db) — restore from DB at server startup (best-effort). */
async function loadInitialState(db) {
  if (!db) { _state.loaded = true; return snapshot(); }
  try {
    const r = await db.query(
      `SELECT engaged, reason, set_by, set_at
         FROM ${getAegisFlags().killSwitch.persistTable}
        ORDER BY set_at DESC
        LIMIT 1`,
    );
    if (r.rows && r.rows.length) {
      const row = r.rows[0];
      _state.engaged = Boolean(row.engaged);
      _state.reason  = row.reason || null;
      _state.setBy   = row.set_by || null;
      _state.setAt   = row.set_at ? new Date(row.set_at).toISOString() : null;
      metrics.killswitch.set(_state.engaged ? 1 : 0);
    }
  } catch (_e) { /* table not yet — leave defaults */ }
  _state.loaded = true;
  return snapshot();
}

/** _resetForTests() — для smoke-тестов. */
function _resetForTests() {
  _state.engaged = false;
  _state.reason  = null;
  _state.setBy   = null;
  _state.setAt   = null;
  _state.loaded  = false;
  metrics.killswitch.set(0);
}

module.exports = {
  isEngaged,
  snapshot,
  engage,
  disengage,
  loadInitialState,
  _resetForTests,
};
