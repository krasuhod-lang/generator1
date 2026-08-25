'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  summaryTimeoutMs,
  withDeadline,
} = require('../src/services/reports/reportSummaryJob');
const { remainingCallTimeout } = require('../src/services/reports/aiAnalyst');

(async () => {
  assert.strictEqual(summaryTimeoutMs({}), 15 * 60 * 1000, 'default summary deadline must be 15 minutes');
  assert.strictEqual(summaryTimeoutMs({ timeoutMs: 60_000 }), 2 * 60 * 1000, 'summary timeout must respect safe minimum');
  assert.strictEqual(summaryTimeoutMs({ timeoutMs: 60 * 60 * 1000 }), 30 * 60 * 1000, 'summary timeout must respect safe maximum');

  const started = Date.now();
  await assert.rejects(
    () => withDeadline(() => new Promise(() => {}), 25),
    (error) => error && error.code === 'report_summary_timeout',
    'hung summary operation must reject with a diagnostic timeout code',
  );
  assert.ok(Date.now() - started < 1000, 'deadline test must finish promptly');

  const deadlineAt = Date.now() + 10_000;
  assert.ok(remainingCallTimeout(deadlineAt, 300_000) <= 10_000, 'provider timeout must not exceed remaining deadline');
  assert.strictEqual(remainingCallTimeout(null, 1234), 1234, 'no deadline must preserve adapter fallback');

  const jobSource = fs.readFileSync(path.join(__dirname, '../src/services/reports/reportSummaryJob.js'), 'utf8');
  const controllerSource = fs.readFileSync(path.join(__dirname, '../src/controllers/reports.controller.js'), 'utf8');
  const pageSource = fs.readFileSync(path.join(__dirname, '../../frontend/src/views/ReportEditorPage.vue'), 'utf8');
  assert.match(jobSource, /setInterval\(safeHeartbeat, heartbeatMs\)/, 'summary job must heartbeat while running');
  assert.match(jobSource, /withDeadline\(async/, 'summary job must enforce an outer deadline');
  assert.match(controllerSource, /heartbeat_at:/, 'status API must expose heartbeat diagnostics');
  assert.match(pageSource, /summaryStale/, 'report UI must detect stale heartbeat');

  console.log('report-summary timeout regression: 8/8 passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
