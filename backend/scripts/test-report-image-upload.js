#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const api = read('frontend/src/api.js');
const renderer = read('frontend/src/components/reports/ReportRenderer.vue');
const routes = read('backend/src/routes/reports.routes.js');
const controller = read('backend/src/controllers/reports.controller.js');
const server = read('backend/server.js');
const reportsStore = read('frontend/src/stores/reports.js');
const frontendNginx = read('frontend/docker-nginx.conf');
const publicReport = read('frontend/src/views/PublicReportPage.vue');

assert(api.includes("config.data instanceof FormData"), 'FormData request detection is missing');
assert(api.includes("delete config.headers['Content-Type']"), 'JSON Content-Type is not removed for multipart uploads');
assert(renderer.includes('clipboardData?.items'), 'clipboard item path is missing');
assert(renderer.includes('clipboardData?.files'), 'clipboard file fallback is missing');
assert(renderer.includes('getAsFile()'), 'clipboard image extraction is missing');
assert(renderer.includes('@paste.capture="onDescriptionPaste'), 'paste capture listener is missing');
assert(renderer.includes('@drop.capture="onDescriptionDrop'), 'drop capture listener is missing');
assert(renderer.includes("form.append('image', file"), 'multipart field must be named image');
assert(renderer.includes("file.size > 5 * 1024 * 1024"), 'client-side image size guard is missing');
assert(renderer.includes("status === 413"), '413 upload handling is missing');
assert(renderer.includes('Максимальный размер — 5 МБ.'), '413 upload message must explain the configured limit');
assert(renderer.includes("resolveUploadUrl(data?.url)"), 'returned upload URL is not normalized');
assert(renderer.includes("/api/uploads/"), 'API upload URL compatibility is missing');
assert(routes.includes("path.join(__dirname, '../../uploads/report-images')"), 'upload directory must be the persistent backend uploads directory');
assert(routes.includes("limits: { fileSize: 5 * 1024 * 1024 }"), 'server-side image size limit is missing');
assert(frontendNginx.includes('client_max_body_size 6m;'), 'frontend proxy upload limit must exceed the 5 MB backend file limit');
assert(routes.includes("imgUpload.single('image')"), 'server-side multipart field mismatch');
assert(controller.includes("const url = `/api/uploads/report-images/${req.file.filename}`"), 'controller must return the served API upload URL');
assert(server.includes("app.use('/api/uploads', express.static(uploadsDir))"), 'API upload static serving is missing');
assert(reportsStore.includes('/tasks-blocks'), 'task blocks persistence endpoint is missing');
assert(renderer.includes("activeTab:   { type: String, default: 'all' }"), 'ReportRenderer activeTab compatibility prop is missing');
assert(renderer.includes('showAnchorNav: { type: Boolean, default: true }'), 'ReportRenderer anchor-nav compatibility prop is missing');
assert(renderer.includes("v-show=\"tabVisible('search')\""), 'search tab must hide/show sections without destroying chart DOM');
assert(renderer.includes("v-show=\"tabVisible('pages')\""), 'pages tab visibility is missing');
assert(renderer.includes("v-show=\"tabVisible('tasks')\""), 'tasks tab visibility is missing');
assert(publicReport.includes('TAB_DEFINITIONS'), 'public report tab definitions are missing');
assert(publicReport.includes('role=\"tablist\"'), 'accessible tablist is missing');
assert(publicReport.includes('role=\"tabpanel\"'), 'accessible tabpanel is missing');
assert(publicReport.includes(':show-anchor-nav=\"false\"'), 'public board must replace anchor nav with tabs');
assert(publicReport.includes('collectReportChartImages'), 'public export functions must remain wired');

console.log('REPORT_IMAGE_UPLOAD_CONTRACT_OK checks=31');
