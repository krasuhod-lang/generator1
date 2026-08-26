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
const migration = read('migrations/140_preserve_published_reports.sql');
const baseMigration = read('migrations/075_smart_reports.sql');
const compose = read('docker-compose.yml');

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
console.log('report contracts: 13/13 passed');
