'use strict';

const db = require('../../config/db');
const { aggregateForDraft } = require('./dataAggregator');
const { generateSummary } = require('./aiAnalyst');

const DEFAULT_SUMMARY_TIMEOUT_MS = 15 * 60 * 1000;
const MIN_SUMMARY_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_SUMMARY_TIMEOUT_MS = 30 * 60 * 1000;

function periodLabel(from, to) {
  const fmt = (value) => {
    const d = new Date(value);
    return d.toLocaleDateString('ru-RU', { year: 'numeric', month: 'long' });
  };
  if (!from || !to) return '';
  return `${fmt(from)} — ${fmt(to)}`;
}

async function loadOwnedDraft(draftId, userId, database = db) {
  const { rows } = await database.query(
    `SELECT d.*, p.name AS project_name, p.url AS project_url,
            p.logo_url, p.color_accent, p.keys_so_domain
       FROM report_drafts d
       JOIN projects p ON p.id = d.project_id
      WHERE d.id = $1 AND d.user_id = $2`,
    [draftId, userId],
  );
  return rows[0] || null;
}

function summaryTimeoutMs(opts = {}) {
  const configured = Number(opts.timeoutMs || process.env.REPORT_SUMMARY_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) return DEFAULT_SUMMARY_TIMEOUT_MS;
  return Math.min(MAX_SUMMARY_TIMEOUT_MS, Math.max(MIN_SUMMARY_TIMEOUT_MS, Math.round(configured)));
}

function timeoutError(timeoutMs) {
  const error = new Error(`AI summary exceeded ${Math.round(timeoutMs / 60000)} minute deadline`);
  error.code = 'report_summary_timeout';
  error.timeoutMs = timeoutMs;
  return error;
}

/**
 * Race a report operation against a hard deadline. The underlying provider
 * request may finish later if its adapter cannot be aborted, but all writes
 * remain protected by llm_lease_token and therefore cannot overwrite a newer
 * run after the timeout handler marks this run as failed.
 */
function withDeadline(work, timeoutMs) {
  let timer = null;
  const operation = Promise.resolve().then(work);
  const deadline = new Promise((_, reject) => {
    // Keep this timer referenced: a hard deadline must fire even when the
    // underlying provider promise is the only pending operation in the process.
    timer = setTimeout(() => reject(timeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function runReportSummaryJob({ draftId, userId, jobId, opts = {} }, database = db) {
  const leaseSeconds = Math.max(30, Number(opts.leaseSeconds) || 60);
  const heartbeatMs = Math.max(
    5000,
    Math.min(Number(opts.heartbeatMs) || 15000, Math.floor((leaseSeconds * 1000) / 2)),
  );
  const deadlineMs = summaryTimeoutMs(opts);

  const claim = await database.query(
    `UPDATE report_drafts
        SET llm_status = 'running',
            llm_worker_id = $4,
            llm_lease_token = $5::uuid,
            llm_lease_until = NOW() + make_interval(secs => $6),
            llm_heartbeat_at = NOW(),
            llm_attempts = COALESCE(llm_attempts, 0) + 1,
            updated_at = NOW()
      WHERE id = $1 AND user_id = $2 AND llm_job_id = $3
        AND llm_status IN ('queued', 'running')
        AND (llm_lease_until IS NULL OR llm_lease_until < NOW())
      RETURNING id`,
    [draftId, userId, jobId, opts.workerId || 'report-summary-worker', opts.leaseToken, leaseSeconds],
  );

  if (!claim.rows.length) return { skipped: true, reason: 'lease_not_acquired' };

  const draft = await loadOwnedDraft(draftId, userId, database);
  if (!draft) return { skipped: true, reason: 'draft_not_found' };

  let currentStage = 'aggregate';
  let heartbeatTimer = null;
  let heartbeatInFlight = false;

  const heartbeat = async (checkpoint = {}) => {
    const result = await database.query(
      `UPDATE report_drafts
          SET llm_heartbeat_at = NOW(),
              llm_lease_until = NOW() + make_interval(secs => $4),
              client_insights = CASE
                WHEN $3::jsonb = '{}'::jsonb THEN client_insights
                ELSE jsonb_set(COALESCE(client_insights, '{}'::jsonb), '{job_checkpoint}', $3::jsonb, true)
              END,
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND llm_job_id = $5
          AND llm_lease_token = $6::uuid AND llm_status = 'running'`,
      [draftId, userId, JSON.stringify(checkpoint || {}), leaseSeconds, jobId, opts.leaseToken],
    );
    if (result.rowCount !== 1) {
      const error = new Error('report_summary_lease_lost');
      error.code = 'report_summary_lease_lost';
      throw error;
    }
  };

  const safeHeartbeat = () => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    heartbeat({ stage: currentStage }).catch((error) => {
      console.warn('[ReportSummary] heartbeat failed:', error.message);
    }).finally(() => {
      heartbeatInFlight = false;
    });
  };

  const deadlineAt = Date.now() + deadlineMs;

  try {
    await heartbeat({ stage: currentStage, percent: 10 });
    heartbeatTimer = setInterval(safeHeartbeat, heartbeatMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();

    const { data, summary } = await withDeadline(async () => {
      currentStage = 'aggregate';
      await heartbeat({ stage: currentStage, percent: 10 });
      const aggregated = await aggregateForDraft(draft, {
        from: opts.from,
        to: opts.to,
        granularity: opts.granularity,
        analysisId: draft.analysis_id,
        snapshotId: draft.snapshot_id,
        persistGrowth: true,
        growthSource: 'report_summary',
        viewMode: 'analyst',
      });

      currentStage = 'generate_summary';
      await heartbeat({ stage: currentStage, percent: 35 });
      const generated = await generateSummary(aggregated, {
        brandName: draft.project_name,
        period: periodLabel(opts.from || draft.date_from, opts.to || draft.date_to),
        deadlineAt,
      });
      return { data: aggregated, summary: generated };
    }, deadlineMs);

    const finished = await database.query(
      `UPDATE report_drafts
          SET llm_status = 'done',
              llm_summary = $3,
              llm_highlights = $4,
              llm_growth = $5,
              llm_quick_wins = $6,
              llm_vulnerabilities = $7,
              llm_roadmap = $8,
              llm_traffic_value = $9,
              llm_next_month_forecast = $11,
              client_insights = $12::jsonb,
              llm_generated_at = NOW(),
              llm_error = NULL,
              llm_last_error_code = NULL,
              llm_worker_id = NULL,
              llm_lease_token = NULL,
              llm_lease_until = NULL,
              llm_heartbeat_at = NOW(),
              data_quality = COALESCE($13::jsonb, data_quality),
              updated_at = NOW()
        WHERE id = $1 AND user_id = $2 AND llm_job_id = $10
          AND llm_lease_token = $14::uuid AND llm_status = 'running'`,
      [
        draftId,
        userId,
        summary.executive_summary || '',
        JSON.stringify(summary.highlights || []),
        JSON.stringify(summary.growth_attribution || []),
        JSON.stringify(summary.quick_wins || []),
        JSON.stringify(summary.vulnerabilities || []),
        JSON.stringify(summary.roadmap || []),
        summary.traffic_value || '',
        jobId,
        summary.next_month_forecast || '',
        JSON.stringify({
          ...(draft.client_insights || {}),
          generated_at: new Date().toISOString(),
          provider: summary.provider || null,
          model: summary.model || null,
          tokens_in: summary.tokens_in || 0,
          tokens_out: summary.tokens_out || 0,
          report_model_version: draft.report_model_version || 'reports-v2',
          ...(summary.work_summary ? { work_summary: summary.work_summary } : {}),
        }),
        JSON.stringify(data?.data_quality || data?.completeness || {}),
        opts.leaseToken,
      ],
    );

    if (finished.rowCount !== 1) return { skipped: true, reason: 'lease_lost_before_finish' };
    return { status: 'done', draftId, jobId };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}

module.exports = {
  runReportSummaryJob,
  loadOwnedDraft,
  periodLabel,
  summaryTimeoutMs,
  withDeadline,
};
