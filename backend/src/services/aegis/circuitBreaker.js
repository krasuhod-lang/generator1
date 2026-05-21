'use strict';

/**
 * aegis/circuitBreaker — простой in-memory circuit breaker.
 *
 * State machine:
 *   CLOSED   → нормальная работа; считаем подряд-фейлы.
 *   OPEN     → последние N=cbFailThreshold подряд провалились;
 *              сразу возвращаем reason='circuit_open' в течение cbOpenSec.
 *   HALF_OPEN→ после cbOpenSec; пускаем cbHalfOpenProbes пробных
 *              запросов. Если все ок → CLOSED, если хоть один фейл → OPEN.
 *
 * Используется в llmRouter для каждого провайдера.
 */

const { getAegisFlags } = require('./featureFlags');

const STATE_CLOSED    = 'closed';
const STATE_OPEN      = 'open';
const STATE_HALF_OPEN = 'half_open';

function createCircuitBreaker(name, opts = {}) {
  const cfg = getAegisFlags().routing;
  const failThreshold  = Number.isFinite(opts.failThreshold) ? opts.failThreshold : cfg.cbFailThreshold;
  const openMs         = (Number.isFinite(opts.openSec) ? opts.openSec : cfg.cbOpenSec) * 1000;
  const halfOpenProbes = Number.isFinite(opts.halfOpenProbes) ? opts.halfOpenProbes : cfg.cbHalfOpenProbes;

  const state = {
    name,
    status:        STATE_CLOSED,
    consecutiveFails: 0,
    openedAt:      0,
    halfOpenAttempts: 0,
    halfOpenSuccesses: 0,
    totalCalls:    0,
    totalFails:    0,
  };

  function _now() { return Date.now(); }

  function canPass() {
    if (state.status === STATE_CLOSED) return true;
    if (state.status === STATE_OPEN) {
      if (_now() - state.openedAt >= openMs) {
        state.status = STATE_HALF_OPEN;
        state.halfOpenAttempts = 0;
        state.halfOpenSuccesses = 0;
        return true;
      }
      return false;
    }
    // HALF_OPEN: разрешаем пока не наберём halfOpenProbes.
    return state.halfOpenAttempts < halfOpenProbes;
  }

  function recordSuccess() {
    state.totalCalls += 1;
    if (state.status === STATE_HALF_OPEN) {
      state.halfOpenAttempts += 1;
      state.halfOpenSuccesses += 1;
      if (state.halfOpenSuccesses >= halfOpenProbes) {
        state.status = STATE_CLOSED;
        state.consecutiveFails = 0;
      }
      return;
    }
    state.consecutiveFails = 0;
  }

  function recordFailure() {
    state.totalCalls += 1;
    state.totalFails += 1;
    if (state.status === STATE_HALF_OPEN) {
      state.halfOpenAttempts += 1;
      state.status = STATE_OPEN;
      state.openedAt = _now();
      return;
    }
    state.consecutiveFails += 1;
    if (state.consecutiveFails >= failThreshold) {
      state.status = STATE_OPEN;
      state.openedAt = _now();
    }
  }

  function snapshot() {
    return {
      name:                state.name,
      status:              state.status,
      consecutive_fails:   state.consecutiveFails,
      total_calls:         state.totalCalls,
      total_fails:         state.totalFails,
      opened_at:           state.openedAt ? new Date(state.openedAt).toISOString() : null,
      ms_until_half_open:  state.status === STATE_OPEN
        ? Math.max(0, openMs - (_now() - state.openedAt))
        : 0,
    };
  }

  function _reset() {
    state.status = STATE_CLOSED;
    state.consecutiveFails = 0;
    state.openedAt = 0;
    state.halfOpenAttempts = 0;
    state.halfOpenSuccesses = 0;
  }

  return {
    canPass, recordSuccess, recordFailure, snapshot,
    _reset, _state: state,
  };
}

module.exports = {
  createCircuitBreaker,
  STATE_CLOSED, STATE_OPEN, STATE_HALF_OPEN,
};
