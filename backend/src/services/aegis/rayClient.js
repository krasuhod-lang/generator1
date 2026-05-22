'use strict';

/**
 * aegis/rayClient — submit-job клиент к Ray Serve (через aegis_py).
 * Графейс-деградирует.
 *
 * Подсистема Ray обещает 150+ параллельных actors. Здесь — только тонкая
 * обёртка над POST /ray/submit и GET /ray/jobs/:id.
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');

function _opts() {
  const cfg = getAegisFlags().ray;
  return {
    base: getAegisFlags().graphrag.pyServiceUrl,
    timeoutMs: cfg.requestTimeoutMs,
    enabled:   cfg.enabled,
  };
}

async function submit({ kind, payload } = {}) {
  const { base, timeoutMs, enabled } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled' };
  return http.post(base, '/ray/submit', { kind, payload }, { timeoutMs });
}

async function getJob(id) {
  const { base, timeoutMs, enabled } = _opts();
  if (!enabled) return { ok: false, reason: 'disabled' };
  return http.get(base, `/ray/jobs/${encodeURIComponent(id)}`, { timeoutMs });
}

async function health() {
  const { base, timeoutMs } = _opts();
  const r = await http.get(base, '/ray/health', { timeoutMs });
  return { ok: r.ok, status: r.status, body: r.body, reason: r.reason };
}

module.exports = { submit, getJob, health };
