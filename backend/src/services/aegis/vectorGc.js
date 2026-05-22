'use strict';

/**
 * aegis/vectorGc — клиент к Vector-DB Garbage Collector в aegis_py.
 *
 * Phase 14.3 — Tombstones для Qdrant. Два режима:
 *   • sweep({ ttlDays }) — ночной крон, удаляет точки старше N дней
 *     в эфемерных коллекциях (evidence_*, serp_*, relevance_*).
 *   • cleanupRun({ runId }) — точечный per-run cleanup после
 *     aegis_runs.status='success'.
 *
 * Грейсфул: если флаги выключены — возвращаем {ok:false, reason}.
 * При сетевой ошибке — то же самое; пайплайн не падает.
 */

const { getAegisFlags } = require('./featureFlags');
const http = require('./_httpClient');
const telemetry = require('./telemetry');

function _opts() {
  const flags = getAegisFlags();
  return {
    base:      flags.graphrag.pyServiceUrl,
    timeoutMs: 5 * 60 * 1000, // 5 минут, sweep по огромной коллекции может занять время
    cfg:       flags.vectorGc,
  };
}

/**
 * sweep({ ttlDays, ephemeralPrefixes, minAgeSafetyHours, dropEmpty }) — TTL-зачистка.
 *
 * Все параметры опциональны: по умолчанию берутся из featureFlags.vectorGc.
 */
async function sweep(opts = {}) {
  const { base, timeoutMs, cfg } = _opts();
  if (!cfg.enabled) {
    return { ok: false, reason: 'disabled', body: null };
  }
  const body = {
    ttl_days:             opts.ttlDays           != null ? Number(opts.ttlDays)           : cfg.ttlDays,
    ephemeral_prefixes:   opts.ephemeralPrefixes || cfg.ephemeralCollectionPrefixes,
    min_age_safety_hours: opts.minAgeSafetyHours != null ? Number(opts.minAgeSafetyHours) : cfg.minAgeSafetyHours,
    drop_empty:           opts.dropEmpty         != null ? Boolean(opts.dropEmpty)        : true,
  };
  const r = await http.post(base, '/vectordb/gc/sweep', body, { timeoutMs });
  _emitTelemetry('sweep', r, body);
  return r;
}

/**
 * cleanupRun({ runId, collections?, ephemeralPrefixes? }) — точечный per-run.
 *
 * Возвращает {ok, body:{points_deleted_total, collections:[{name, deleted}]}}.
 * При отсутствии runId или disabled — graceful no-op.
 */
async function cleanupRun(opts = {}) {
  const { base, timeoutMs, cfg } = _opts();
  if (!cfg.enabled || !cfg.perRunCleanup) {
    return { ok: false, reason: 'disabled', body: null };
  }
  const runId = String(opts.runId || '').trim();
  if (!runId) {
    return { ok: false, reason: 'run_id_required', body: null };
  }
  const body = {
    run_id:             runId,
    collections:        opts.collections        || null,
    ephemeral_prefixes: opts.ephemeralPrefixes  || cfg.ephemeralCollectionPrefixes,
  };
  const r = await http.post(base, '/vectordb/gc/run', body, { timeoutMs });
  _emitTelemetry('per_run', r, body);
  return r;
}

async function health() {
  const { base, timeoutMs } = _opts();
  const r = await http.get(base, '/vectordb/gc/health', { timeoutMs: 5000 });
  return { ok: r.ok, status: r.status, body: r.body, reason: r.reason };
}

function _emitTelemetry(kind, r, req) {
  try {
    if (!telemetry || !telemetry.M) return;
    const deleted = (r && r.body && Number(r.body.points_deleted_total)) || 0;
    const seen    = (r && r.body && Number(r.body.collections_seen))    || 0;
    if (telemetry.M.vectorGcPointsDeleted && typeof telemetry.M.vectorGcPointsDeleted.inc === 'function') {
      telemetry.M.vectorGcPointsDeleted.inc(deleted, { kind });
    }
    if (telemetry.M.vectorGcRuns && typeof telemetry.M.vectorGcRuns.inc === 'function') {
      telemetry.M.vectorGcRuns.inc(1, { kind, ok: r && r.ok ? '1' : '0' });
    }
    // если telemetry-counters ещё не созданы (старый билд) — игнорируем
    void seen;
    void req;
  } catch (_) { /* graceful */ }
}

module.exports = { sweep, cleanupRun, health };
