'use strict';

const crypto = require('crypto');
const os = require('os');
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const db = require('../config/db');
const { ensureDurableTaskSchema } = require('../services/tasks/durableSchema');
const {
  claimProjectAnalysis,
  heartbeatProjectAnalysis,
  finishProjectAnalysis,
} = require('../services/tasks/reliability');
const { processAnalysis } = require('../services/projects/analysisRunner');
const { runReportSummaryJob } = require('../services/reports/reportSummaryJob');

const WORKER_ID = `${os.hostname()}:${process.pid}:projects-reports:${crypto.randomUUID()}`;
const LEASE_SECONDS = Math.max(30, Number(process.env.TASK_LEASE_SECONDS) || 60);
const HEARTBEAT_MS = Math.max(5000, Number(process.env.TASK_HEARTBEAT_MS) || 15000);

let analysisWorker = null;
let summaryWorker = null;
let startPromise = null;

async function markSummaryError({ draftId, userId, jobId, token, error }) {
  await db.query(
    `UPDATE report_drafts
        SET llm_status='error',
            llm_error=$4,
            llm_last_error_code=$5,
            llm_worker_id=NULL,
            llm_lease_token=NULL,
            llm_lease_until=NULL,
            llm_heartbeat_at=NOW(),
            updated_at=NOW()
      WHERE id=$1 AND user_id=$2 AND llm_job_id=$3
        AND llm_lease_token=$6::uuid`,
    [
      draftId,
      userId,
      jobId,
      String(error?.message || error || 'summary_failed').slice(0, 1000),
      error?.code || 'summary_failed',
      token,
    ],
  );
}

async function startProjectReportWorkers() {
  if (startPromise) return startPromise;
  startPromise = (async () => {
    await ensureDurableTaskSchema();

    analysisWorker = new Worker(
      'project-analysis',
      async (job) => {
        const { analysisId, jobId } = job.data || {};
        if (!analysisId || !jobId) throw new Error('project_analysis_job_payload_invalid');
        const claim = await claimProjectAnalysis(analysisId, jobId, WORKER_ID);
        if (!claim) return { skipped: true, reason: 'analysis_lease_not_acquired' };

        try {
          await processAnalysis(analysisId, {
            leaseToken: claim.token,
            heartbeatMs: HEARTBEAT_MS,
            heartbeat: (checkpoint) => heartbeatProjectAnalysis(analysisId, claim.token, checkpoint),
          });
          return { analysisId, status: 'completed' };
        } catch (error) {
          await finishProjectAnalysis(analysisId, claim.token, 'error', error).catch(() => {});
          throw error;
        }
      },
      { connection, concurrency: Math.max(1, Number(process.env.PROJECT_ANALYSIS_WORKER_CONCURRENCY) || 1) },
    );

    summaryWorker = new Worker(
      'report-summary',
      async (job) => {
        const { draftId, userId, jobId, opts = {} } = job.data || {};
        if (!draftId || !userId || !jobId) throw new Error('report_summary_job_payload_invalid');
        const token = crypto.randomUUID();
        try {
          return await runReportSummaryJob({
            draftId,
            userId,
            jobId,
            opts: {
              ...opts,
              leaseToken: token,
              leaseSeconds: LEASE_SECONDS,
              heartbeatMs: HEARTBEAT_MS,
              workerId: WORKER_ID,
            },
          });
        } catch (error) {
          await markSummaryError({ draftId, userId, jobId, token, error }).catch(() => {});
          throw error;
        }
      },
      { connection, concurrency: Math.max(1, Number(process.env.REPORT_SUMMARY_WORKER_CONCURRENCY) || 1) },
    );

    for (const [name, worker] of [['project-analysis', analysisWorker], ['report-summary', summaryWorker]]) {
      worker.on('error', (error) => {
        console.error(`[ProjectReportWorker][${name}] BullMQ error:`, error.message);
      });
      worker.on('completed', (job) => {
        console.log(`[ProjectReportWorker][${name}] completed job=${job.id}`);
      });
      worker.on('failed', (job, error) => {
        console.error(`[ProjectReportWorker][${name}] failed job=${job?.id}:`, error.message);
      });
      worker.on('stalled', (jobId) => {
        console.warn(`[ProjectReportWorker][${name}] stalled job=${jobId}`);
      });
    }

    console.log('[ProjectReportWorker] durable project-analysis/report-summary workers started');
  })().catch((error) => {
    startPromise = null;
    throw error;
  });
  return startPromise;
}

async function requeueProjectReportOwnedWork() {
  const recovered = { projectAnalyses: 0, reportSummaries: 0 };
  try {
    const analyses = await db.query(
      `UPDATE project_analyses
          SET status='queued', worker_id=NULL, lease_token=NULL, lease_until=NULL,
              heartbeat_at=NOW(), completed_at=NULL,
              last_error_code='worker_shutdown',
              error_message='Worker остановлен; анализ будет возобновлён', updated_at=NOW()
        WHERE worker_id=$1 AND status='running'
        RETURNING id`,
      [WORKER_ID],
    );
    recovered.projectAnalyses = analyses.rowCount || 0;
  } catch (error) {
    console.warn('[ProjectReportWorker] project-analysis shutdown requeue failed:', error.message);
  }

  try {
    const summaries = await db.query(
      `UPDATE report_drafts
          SET llm_status='queued', llm_worker_id=NULL, llm_lease_token=NULL,
              llm_lease_until=NULL, llm_heartbeat_at=NOW(),
              llm_error='Worker остановлен; AI summary будет возобновлено',
              llm_last_error_code='worker_shutdown', updated_at=NOW()
        WHERE llm_worker_id=$1 AND llm_status='running'
        RETURNING id`,
      [WORKER_ID],
    );
    recovered.reportSummaries = summaries.rowCount || 0;
  } catch (error) {
    console.warn('[ProjectReportWorker] report-summary shutdown requeue failed:', error.message);
  }
  console.log('[ProjectReportWorker] shutdown recovery:', recovered);
  return recovered;
}

async function stopProjectReportWorkers() {
  const workers = [analysisWorker, summaryWorker].filter(Boolean);
  analysisWorker = null;
  summaryWorker = null;
  startPromise = null;
  await Promise.all(workers.map((worker) => worker.close().catch(() => {})));
}

module.exports = {
  startProjectReportWorkers,
  stopProjectReportWorkers,
  requeueProjectReportOwnedWork,
};
