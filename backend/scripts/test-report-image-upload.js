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

assert(api.includes("config.data instanceof FormData"), 'FormData request detection is missing');
assert(api.includes("delete config.headers['Content-Type']"), 'JSON Content-Type is not removed for multipart uploads');
assert(renderer.includes('clipboardData?.items'), 'clipboard item path is missing');
assert(renderer.includes('clipboardData?.files'), 'clipboard file fallback is missing');
assert(renderer.includes('getAsFile()'), 'clipboard image extraction is missing');
assert(renderer.includes('@paste.capture="onDescriptionPaste'), 'paste capture listener is missing');
assert(renderer.includes('@drop.capture="onDescriptionDrop'), 'drop capture listener is missing');
assert(renderer.includes("form.append('image', file"), 'multipart field must be named image');
assert(renderer.includes("file.size > 5 * 1024 * 1024"), 'client-side image size guard is missing');
assert(renderer.includes("resolveUploadUrl(data?.url)"), 'returned upload URL is not normalized');
assert(renderer.includes("/api/uploads/"), 'API upload URL compatibility is missing');
assert(routes.includes("path.join(__dirname, '../../uploads/report-images')"), 'upload directory must be the persistent backend uploads directory');
assert(routes.includes("limits: { fileSize: 5 * 1024 * 1024 }"), 'server-side image size limit is missing');
assert(routes.includes("imgUpload.single('image')"), 'server-side multipart field mismatch');
assert(controller.includes("const url = `/api/uploads/report-images/${req.file.filename}`"), 'controller must return the served API upload URL');
assert(server.includes("app.use('/api/uploads', express.static(uploadsDir))"), 'API upload static serving is missing');
assert(reportsStore.includes('/tasks-blocks'), 'task blocks persistence endpoint is missing');

console.log('REPORT_IMAGE_UPLOAD_CONTRACT_OK checks=18');
