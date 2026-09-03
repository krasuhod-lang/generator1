'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  normalizeReportBlocks,
  detectImageType,
} = require('../src/services/reports/reportContent');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const controller = read('backend/src/controllers/reports.controller.js');
const routes = read('backend/src/routes/reports.routes.js');
const renderer = read('frontend/src/components/reports/ReportRenderer.vue');
const publicPage = read('frontend/src/views/PublicReportPage.vue');
const analyst = read('backend/src/services/reports/aiAnalyst.js');
const summaryJob = read('backend/src/services/reports/reportSummaryJob.js');
const projectsConfig = read('backend/src/services/projects/config.js');
const migration = read('migrations/140_preserve_published_reports.sql');
const baseMigration = read('migrations/075_smart_reports.sql');
const compose = read('docker-compose.yml');
const {
  _buildWorkDigest,
  _fallbackWorkSummary,
  _normalizeWorkSummary,
} = require('../src/services/reports/aiAnalyst');

function ok(name, condition) {
  assert.ok(condition, name);
  console.log(`  ✓ ${name}`);
}

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const blocks = normalizeReportBlocks([{
  month: '2026-08',
  sections: [{ title: 'SEO', tasks: [{ title: 'Главная задача', children: [{ title: 'Микрозадача', description: 'Проверка' }] }] }],
}]);
ok('normalizer preserves month → section → task → subtask', blocks[0].sections[0].tasks[0].subtasks[0].title === 'Микрозадача');
ok('PNG magic bytes detected', detectImageType(png) === 'png');

const publicPdfStart = controller.indexOf('async function publicExportPdf');
const publicPdf = controller.slice(publicPdfStart);
ok('public PDF forwards chart_images', publicPdf.includes('chart_images: Array.isArray(req.body?.chart_images)'));
ok('all exporters receive saved AI metadata', controller.includes('ai_metadata: reportSummary.ai_metadata') && controller.includes('ai_metadata: summary.ai_metadata'));
ok('public loader selects AI metadata fields', controller.includes('d.llm_status, d.llm_generated_at') && controller.includes('d.client_insights'));
ok('draft delete explicitly preserves shared links', controller.includes("error: 'published_report_preserved'") && controller.includes('SELECT uuid, is_active FROM shared_reports'));
ok('upload endpoint uses expected multipart field', routes.includes("imgUpload.single('image')"));
ok('upload filenames use UUID + MIME extension', routes.includes('crypto.randomUUID()') && routes.includes('extByMime'));
ok('frontend lets browser set multipart boundary', renderer.includes("api.post('/reports/upload-image', form)") && !renderer.includes("headers: { 'Content-Type': 'multipart/form-data' }"));
ok('frontend exposes upload errors and retry cleanup', renderer.includes('uploadError') && renderer.includes('input.value ='));
ok('base schema protects draft and user FK', baseMigration.includes('draft_id        UUID NOT NULL REFERENCES report_drafts(id) ON DELETE RESTRICT') && baseMigration.includes('user_id         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT'));
ok('existing DB gets idempotent RESTRICT migration', migration.includes('fk_shared_reports_draft_preserve') && migration.includes('ON DELETE RESTRICT') && migration.includes('fk_shared_reports_user_preserve'));
ok('report uploads are persistent across normal container rebuild', compose.includes('- uploads:/app/uploads') && compose.includes('uploads:/app/uploads'));
ok('public board exposes a separate work summary tab', publicPage.includes("id: 'work-summary'") && publicPage.includes(':work-summary="result.payload?.summary?.work_summary || null"'));
ok('work summary tab is data-driven and hides when absent', publicPage.includes("tab.id === 'work-summary'") && publicPage.includes('work.overview'));
ok('monthly work tabs select one month in readonly mode', renderer.includes('selectedWorkMonth') && renderer.includes('displayedWorkMonths') && renderer.includes('role="tab"'));
ok('work cards render explicit safe result links', renderer.includes('task-result-link') && renderer.includes('isSafeExternalUrl'));
ok('AI digest groups factual work items by ISO week', analyst.includes('_buildWorkDigest') && analyst.includes('_isoWeekLabel') && analyst.includes('source_ids'));
ok('AI output normalizes work summary to source item IDs', analyst.includes('_normalizeWorkSummary') && analyst.includes('ids.has(id)'));
ok('report summary job persists work_summary without replacing client insights', summaryJob.includes('...(summary.work_summary ? { work_summary: summary.work_summary } : {})'));
ok('report analyzer defaults to Gemini 3.1 Pro Preview', projectsConfig.includes("model: 'gemini-3.1-pro-preview'"));
ok('public report merges persisted/fallback work summary without changing blocks', controller.includes('fallbackWorkSummary') && controller.includes('payload.tasks_blocks'));
const workFixture = _buildWorkDigest({ tasks: { items: [
  { id: 'a', title: 'Аудит', task_type: 'technical_seo', performed_at: '2026-08-05', description: '<p>Проверка</p>', link: 'https://example.com/a' },
  { id: 'b', title: 'Статья', task_type: 'content_generation', performed_at: '2026-08-06', description: '<p>Публикация</p>' },
  { id: 'c', title: 'Без даты', task_type: 'other' },
] } });
ok('work digest groups dated items into ISO weeks', workFixture.weeks.length === 2 && workFixture.weeks[0].items.length === 2);
const fallbackWork = _fallbackWorkSummary(workFixture, 'август 2026');
ok('fallback work summary stays factual and includes source IDs', fallbackWork.source === 'data' && fallbackWork.weeks[0].source_ids.includes('a'));
const normalizedWork = _normalizeWorkSummary({ overview: 'Готово', weeks: [{ week: '2026-08-03 — 2026-08-09', title: 'Работа', bullets: ['Факт'], source_ids: ['a', 'unknown'] }] }, workFixture, 'август 2026');
ok('normalized work summary drops unknown source IDs', normalizedWork.source === 'gemini' && normalizedWork.weeks[0].source_ids.length === 1 && normalizedWork.weeks[0].source_ids[0] === 'a');
console.log('report contracts: 26/26 passed');
