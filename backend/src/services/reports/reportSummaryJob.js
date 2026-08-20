'use strict';

const db = require('../../config/db');
const { aggregateForDraft } = require('./dataAggregator');
const { generateSummary } = require('./aiAnalyst');

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

async function runReportSummaryJob({ draftId, userId, jobId, opts = {} }, database = db) {
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
    [draftId, userId, jobId, opts.workerId || 'report-summary-worker', opts.leaseToken, opts.leaseSeconds || 60],
  );

  if (!claim.rows.length) return { skipped: true, reason: 'lease_not_acquired' };

  const draft = await loadOwnedDraft(draftId, userId, database);
  if (!draft) return { skipped: true, reason: 'draft_not_found' };

  const heartbeat = async (checkpoint = {}) => {
    await database.query(
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
      [draftId, userId, JSON.stringify(checkpoint || {}), opts.leaseSeconds || 60, jobId, opts.leaseToken],
    );
  };

  await heartbeat({ stage: 'aggregate', percent: 10 });
  const data = await aggregateForDraft(draft, {
    from: opts.from,
    to: opts.to,
    granularity: opts.granularity,
    analysisId: draft.analysis_id,
    snapshotId: draft.snapshot_id,
    persistGrowth: true,
    growthSource: 'report_summary',
    viewMode: 'analyst',
  });

  await heartbeat({ stage: 'generate_summary', percent: 35 });
  const summary = await generateSummary(data, {
    brandName: draft.project_name,
    period: periodLabel(draft.date_from, draft.date_to),
  });

  await database.query(
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
        AND llm_lease_token = $14::uuid`,
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
      }),
      JSON.stringify(data?.data_quality || data?.completeness || {}),
      opts.leaseToken,
    ],
  );

  return { status: 'done', draftId, jobId };
}

module.exports = { runReportSummaryJob, loadOwnedDraft, periodLabel };
