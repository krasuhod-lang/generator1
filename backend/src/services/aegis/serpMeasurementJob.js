const dbDefault = require('../../config/db');
const { getAegisFlags } = require('./featureFlags');
const tracker = require('./serpOutcomeTracker');
const experimentLoop = require('./experimentLoop');
const gscService = require('../projects/gscService');
const ydxService = require('../projects/ydxService');

let _db = dbDefault;
let _timer = null;
let _firstTimer = null;
let _running = false;

function setDbConnection(db) {
  _db = db || dbDefault;
  tracker.setDbConnection(_db);
}

function _isoDate(value) {
  const d = value instanceof Date ? new Date(value) : new Date(String(value || ''));
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function _measurementRange(row, now = new Date()) {
  const from = _isoDate(row.published_at);
  const safeEnd = new Date(now);
  safeEnd.setUTCDate(safeEnd.getUTCDate() - 2);
  const to = safeEnd.toISOString().slice(0, 10);
  return { from, to };
}

function _aggregateRows(rows, queries, source) {
  const wanted = new Set((queries || []).map((q) => String(q).trim().toLocaleLowerCase()).filter(Boolean));
  const matched = (rows || []).filter((row) => {
    const q = String(row.query || row.key || '').trim().toLocaleLowerCase();
    return wanted.size === 0 || wanted.has(q);
  });
  const clicks = matched.reduce((sum, row) => sum + (Number(row.clicks) || 0), 0);
  const impressions = matched.reduce((sum, row) => sum + (Number(row.impressions) || 0), 0);
  const weightedPosition = matched.reduce((sum, row) => {
    const position = Number(row.position) || 0;
    const weight = Number(row.impressions) || 0;
    return position > 0 ? sum + position * Math.max(1, weight) : sum;
  }, 0);
  const positionWeight = matched.reduce((sum, row) => {
    const position = Number(row.position) || 0;
    return position > 0 ? sum + Math.max(1, Number(row.impressions) || 0) : sum;
  }, 0);
  const positions = matched.map((row) => Number(row.position) || 0).filter((p) => p > 0);
  const avgPosition = positionWeight ? weightedPosition / positionWeight : null;
  const ctr = impressions ? (clicks / impressions) * 100 : 0;
  return {
    source,
    sampleSize: matched.length,
    clicks,
    impressions,
    ctr,
    avgPosition,
    bestPosition: positions.length ? Math.min(...positions) : null,
    inTop3: positions.filter((p) => p <= 3).length,
    inTop10: positions.filter((p) => p <= 10).length,
  };
}

async function collectOutcomeMetrics(row, now = new Date()) {
  if (!row || !row.project_id) throw new Error('project_missing');
  const projectResult = await _db.query(
    `SELECT * FROM projects WHERE id = $1 LIMIT 1`,
    [row.project_id],
  );
  const project = projectResult.rows[0];
  if (!project) throw new Error('project_not_found');
  const range = _measurementRange(row, now);
  if (!range.from || range.from > range.to) throw new Error('measurement_window_not_ready');

  const queries = Array.isArray(row.queries) ? row.queries : [];
  if (project.gsc_connected && project.gsc_site_url) {
    const rows = await gscService.fetchQueryPageMatrix(
      project,
      range,
      { page: row.url, rowLimit: 1000 },
    );
    return _withDelta(_aggregateRows(rows, queries, 'gsc'), row.baseline_metrics);
  }
  if (project.ydx_connected && project.ydx_site_url) {
    const rows = await ydxService.fetchTopQueries(project, range, { rowLimit: 1000 });
    return _withDelta(_aggregateRows(rows, queries, 'yandex'), row.baseline_metrics);
  }
  throw new Error('search_source_not_connected');
}

function _withDelta(metrics, baselineRaw) {
  const baseline = baselineRaw && typeof baselineRaw === 'object' ? baselineRaw : {};
  const baselineClicks = Number(baseline.clicks);
  const baselineCtr = Number(baseline.ctr);
  return {
    ...metrics,
    deltaClicks: Number.isFinite(baselineClicks) ? metrics.clicks - baselineClicks : null,
    deltaCtr: Number.isFinite(baselineCtr) ? metrics.ctr - baselineCtr : null,
  };
}

async function _claimDue(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const { rows } = await _db.query(
    `UPDATE aegis_serp_outcomes
        SET status = 'measuring',
            measurement_attempts = COALESCE(measurement_attempts, 0) + 1,
            last_error = NULL
      WHERE id IN (
        SELECT id
          FROM aegis_serp_outcomes
         WHERE status = 'pending'
           AND (measure_after_at IS NULL OR measure_after_at <= NOW())
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY published_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
      )
      RETURNING *`,
    [safeLimit],
  );
  return rows || [];
}

async function _retry(row, error) {
  const attempts = Math.max(1, Number(row.measurement_attempts) || 1);
  const delayMinutes = Math.min(24 * 60, 5 * (2 ** Math.min(8, attempts - 1)));
  await _db.query(
    `UPDATE aegis_serp_outcomes
        SET status = 'pending',
            next_attempt_at = NOW() + ($2::int * INTERVAL '1 minute'),
            last_error = $3
      WHERE id = $1 AND status = 'measuring'`,
    [row.id, delayMinutes, String(error && error.message || error || 'measurement_failed').slice(0, 1000)],
  );
}

async function _claimDueExperiments(limit = 10) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const { rows } = await _db.query(
    `UPDATE aegis_experiments
        SET status='measuring',
            measurement_attempts=COALESCE(measurement_attempts, 0) + 1,
            last_error=NULL
      WHERE id IN (
        SELECT id FROM aegis_experiments
         WHERE status='dispatched'
           AND (measure_after_at IS NULL OR measure_after_at <= NOW())
           AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         ORDER BY dispatched_at ASC NULLS LAST
         FOR UPDATE SKIP LOCKED LIMIT $1
      )
      RETURNING *`,
    [safeLimit],
  );
  return rows || [];
}

async function _retryExperiment(row, error) {
  const attempts = Math.max(1, Number(row.measurement_attempts) || 1);
  const delayMinutes = Math.min(24 * 60, 5 * (2 ** Math.min(8, attempts - 1)));
  await _db.query(
    `UPDATE aegis_experiments
        SET status='dispatched',
            next_attempt_at=NOW() + ($2::int * INTERVAL '1 minute'),
            last_error=$3
      WHERE id=$1 AND status='measuring'`,
    [row.id, delayMinutes, String(error && error.message || error || 'experiment_measurement_failed').slice(0, 1000)],
  );
}

async function measureDueExperiments({ limit = 10, measureFn = collectOutcomeMetrics } = {}) {
  const flags = getAegisFlags().experiments || {};
  if (!flags.enabled) return { ok: true, skipped: true, reason: 'disabled', measured: 0, failed: 0 };
  const rows = await _claimDueExperiments(limit);
  let measured = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      if (!row.project_id) throw new Error('experiment_project_missing');
      const metrics = await measureFn({
        ...row,
        id: row.id,
        url: row.target_url,
        published_at: row.dispatched_at || row.planned_at || row.measure_after_at,
        baseline_metrics: {
          clicks: row.baseline_clicks,
        },
      });
      if (!metrics || !Number.isFinite(Number(metrics.sampleSize)) || Number(metrics.sampleSize) <= 0) {
        throw new Error('no_experiment_measurement_rows');
      }
      const result = await experimentLoop.closeExperiment(_db, row.id, metrics);
      if (!result.ok) throw new Error(result.reason || 'close_experiment_failed');
      measured += 1;
    } catch (error) {
      failed += 1;
      await _retryExperiment(row, error).catch(() => {});
    }
  }
  const feedback = await experimentLoop.retryMeasuredExperimentFeedback(_db, { limit }).catch((error) => ({
    ok: false,
    reason: error.message,
  }));
  return { ok: true, skipped: false, claimed: rows.length, measured, failed, feedback };
}

async function measureDueOutcomes({ limit = 10, measureFn = collectOutcomeMetrics } = {}) {
  const flags = getAegisFlags().serpOutcomes || {};
  if (!flags.enabled) return { ok: true, skipped: true, reason: 'disabled', measured: 0, failed: 0 };
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const rows = await _claimDue(safeLimit);
  let measured = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const metrics = await measureFn(row);
      if (!metrics || !Number.isFinite(Number(metrics.sampleSize)) || Number(metrics.sampleSize) <= 0) {
        throw new Error('no_measurement_rows');
      }
      const result = await tracker.closeOutcome(row.id, metrics);
      if (!result.ok) throw new Error(result.reason || 'close_outcome_failed');
      measured += 1;
    } catch (error) {
      failed += 1;
      await _retry(row, error).catch(() => {});
    }
  }
  const feedback = await tracker.retryMeasuredFeedback({ limit: safeLimit }).catch((error) => ({
    ok: false,
    reason: error.message,
  }));
  return { ok: true, skipped: false, claimed: rows.length, measured, failed, feedback };
}

async function tick() {
  if (_running) return { ok: true, skipped: true, reason: 'already_running' };
  _running = true;
  try {
    const outcomes = await measureDueOutcomes({ limit: 10 });
    const experiments = await measureDueExperiments({ limit: 10 });
    return { ...outcomes, experiments };
  } catch (error) {
    console.warn('[aegis/serpMeasurementJob] tick failed:', error.message);
    return { ok: false, error: error.message };
  } finally {
    _running = false;
  }
}

function startSerpMeasurementScheduler() {
  if (_timer) return;
  const intervalMs = Math.max(
    60_000,
    Number(process.env.AEGIS_SERP_MEASURE_INTERVAL_MS) || 15 * 60 * 1000,
  );
  _firstTimer = setTimeout(() => tick().catch(() => {}), 60_000);
  _firstTimer.unref?.();
  _timer = setInterval(() => tick().catch(() => {}), intervalMs);
  _timer.unref?.();
}

function stopSerpMeasurementScheduler() {
  if (_firstTimer) clearTimeout(_firstTimer);
  if (_timer) clearInterval(_timer);
  _firstTimer = null;
  _timer = null;
  _running = false;
}

module.exports = {
  setDbConnection,
  collectOutcomeMetrics,
  measureDueOutcomes,
  measureDueExperiments,
  startSerpMeasurementScheduler,
  stopSerpMeasurementScheduler,
  _aggregateRows,
  _measurementRange,
};
