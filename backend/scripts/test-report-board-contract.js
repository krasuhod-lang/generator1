#!/usr/bin/env node
/**
 * Static regression for additive report-board contracts.
 * No database, network, credentials or user data are used.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const reportsPage = read('frontend/src/views/ReportsPage.vue');
const editor = read('frontend/src/views/ReportEditorPage.vue');
const renderer = read('frontend/src/components/reports/ReportRenderer.vue');
const sharedReports = read('frontend/src/views/SharedReportsPage.vue');
const controller = read('backend/src/controllers/reports.controller.js');
const headline = read('backend/src/services/reports/headlineBuilder.js');
const aggregator = read('backend/src/services/reports/dataAggregator.js');
const sanitizer = read('backend/src/services/reports/viewModeSanitizer.js');
const aiAnalyst = read('backend/src/services/reports/aiAnalyst.js');

assert(reportsPage.includes('filteredDrafts'), 'ReportsPage must expose filtered board data');
assert(reportsPage.includes('report-stats-grid'), 'ReportsPage must expose board KPI cards');
assert(reportsPage.includes('shared_uuid'), 'ReportsPage must render existing permanent-link metadata');
assert(reportsPage.includes('copyLink'), 'ReportsPage must provide safe permanent-link copy action');
assert(reportsPage.includes('reports-board'), 'ReportsPage must expose responsive card board');
assert(editor.includes('saveAiEdits'), 'ReportEditorPage must expose manual AI save');
assert(editor.includes('patchSummary'), 'ReportEditorPage must use the existing summary patch API');
assert(editor.includes('rep-quick-nav'), 'ReportEditorPage must expose quick report navigation');
assert(renderer.includes('report-executive-summary'), 'ReportRenderer must show executive summary');
assert(renderer.includes('ai-subsection--positive'), 'ReportRenderer must show positive-first analysis');
assert(renderer.includes('ai-subsection--attention'), 'ReportRenderer must show attention/reason blocks');
assert(renderer.includes('task.completed === true'), 'ReportRenderer must support additive checklist completion');
assert(sharedReports.includes('sr-table-scroll'), 'SharedReportsPage must keep a mobile overflow container');
assert(sharedReports.includes('/r/${uuid}'), 'SharedReportsPage must preserve the public report URL shape');
assert(controller.includes('sr.draft_id = $1 AND sr.user_id = $2'), 'publish lookup must be draft-scoped');
assert(controller.includes('[draft.id, req.user.id]'), 'publish lookup must bind draft.id, not project.id');
assert(controller.includes('LEFT JOIN LATERAL'), 'draft list must expose its own earliest permanent link');
assert(renderer.includes('period-context'), 'ReportRenderer must expose applied period context');
assert(renderer.includes('metric-switcher'), 'ReportRenderer must expose one-metric chart switcher');
assert(renderer.includes('task-status-badge'), 'ReportRenderer must show explicit task status states');
assert(renderer.includes('totals_complete'), 'ReportRenderer must prefer complete-period totals in client mode');
assert(headline.includes("status: 'no_comparison'"), 'headline must fail closed when comparison is unavailable');
assert(headline.includes('comparison'), 'headline must return comparison context');
assert(aggregator.includes('context_hash'), 'dataAggregator must emit deterministic context hash');
assert(aggregator.includes('forecast: null'), 'dataAggregator must not expose naive forecast');
assert(controller.includes('ai_notice'), 'public controller must expose stale/not-bound AI notice');
assert(controller.includes('function _reportTitle'), 'public controller must derive title from applied period');
assert(sanitizer.includes('ai_snapshot_id'), 'client sanitizer must hide AI context diagnostics');
assert(read('frontend/src/views/PublicReportPage.vue').includes('requestSeq'), 'public page must reject stale range responses');
assert(read('frontend/src/views/PublicReportPage.vue').includes('router.replace'), 'public page must persist tab/range state in URL');
assert(aiAnalyst.includes('evidence-first SEO'), 'report AI must use evidence-first system policy');
assert(aiAnalyst.includes("next_month_forecast: ''"), 'report AI must not publish unvalidated forecast');
console.log('REPORT_BOARD_CONTRACT_OK checks=32');
