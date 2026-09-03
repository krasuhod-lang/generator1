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
console.log('REPORT_BOARD_CONTRACT_OK checks=17');
