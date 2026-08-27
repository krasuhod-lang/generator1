const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const style = read('frontend/src/style.css');
const appLayout = read('frontend/src/components/AppLayout.vue');
const adminLayout = read('frontend/src/components/AdminLayout.vue');
const reports = read('frontend/src/views/ReportsPage.vue');
const editor = read('frontend/src/views/ReportEditorPage.vue');
const outreach = read('frontend/src/views/OutreachPage.vue');
const campaign = read('frontend/src/views/OutreachCampaignPage.vue');
const dashboard = read('frontend/src/views/DashboardPage.vue');
const project = read('frontend/src/views/ProjectDetailPage.vue');
const renderer = read('frontend/src/components/reports/ReportRenderer.vue');

assert.match(style, /--app-header-h:\s*64px/);
assert.match(style, /--app-content-max:\s*1280px/);
assert.match(style, /--app-content-gutter:\s*clamp\(16px/);
assert.match(style, /\.app-header[\s\S]*position:\s*sticky[\s\S]*z-index:\s*var\(--app-overlay-z\)/);
assert.match(style, /\.app-main[\s\S]*min-width:\s*0/);
assert.match(style, /\.app-main > \.max-w-7xl[\s\S]*padding:\s*var\(--app-page-top\)/);
assert.match(style, /\.project-tasks-table-wrap[\s\S]*overflow-x:\s*auto/);
assert.match(appLayout, /<main class="app-main flex-1 min-w-0">/);
assert.match(adminLayout, /<main class="app-main flex-1 min-w-0">/);
assert.match(reports, /margin: 0 auto;[\s\S]*padding: var\(--app-page-top\)/);
assert.match(reports, /<div v-else class="rp-table-wrap">/);
assert.match(editor, /padding: var\(--app-page-top\)[\s\S]*margin: 0;/);
assert.match(outreach, /padding: var\(--app-page-top\) var\(--app-content-gutter\)/);
assert.match(campaign, /top: var\(--app-header-h\)/);
assert.match(dashboard, /class="app-alert-container"/);
assert.match(project, /class="project-tasks-table-wrap"/);
assert.match(renderer, /top: calc\(var\(--app-header-h\) \+ 12px\)/);

console.log('layout consistency regression: 17/17 checks passed');
