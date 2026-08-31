'use strict';

/**
 * Source-level regression for the unified user Task Center and blog viewer.
 * No network or database access.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const routes = read('backend/src/routes/tasks.routes.js');
const admin = read('backend/src/controllers/admin.controller.js');
const tasksStore = read('frontend/src/stores/tasks.js');
const dashboard = read('frontend/src/views/DashboardPage.vue');
const infoPage = read('frontend/src/views/InfoArticlePage.vue');

assert.match(routes, /router\.get\('\/all',\s*authMiddleware,\s*getUserAllTasks\)/,
  'user task-center route must be registered before /:id routes');
assert.match(admin, /const userId = req\.params\.userId \|\| req\.user\?\.id/,
  'cross-module list must use the authenticated user when no admin userId is present');
assert.match(admin, /const safeRows = rows\.map/,
  'cross-module list must project a safe user-facing row');
assert.match(admin, /source_label:/,
  'cross-module list must include a human-readable source label');
assert.match(admin, /cost_usd: privileged \? row\.cost_usd : null/,
  'client rows must not expose task cost');
assert.match(tasksStore, /api\.get\('\/tasks'\)/,
  'legacy SEO fetchTasks contract must remain intact');
assert.match(tasksStore, /async function fetchAllTasks[\s\S]*api\.get\('\/tasks\/all'/,
  'Task Center must use a separate all-module store action');
assert.match(dashboard, /store\.allTasks/,
  'Dashboard must render the cross-module list, not store.tasks');
assert.match(dashboard, /info_article:[\s\S]*\/info-article/,
  'Dashboard must open blog tasks through the supported query deep-link');
assert.match(dashboard, /link_article:[\s\S]*\/link-article/,
  'Dashboard must open link tasks through the supported query deep-link');
assert.match(infoPage, /const sanitizeArticleCandidate = \(candidate\) => DOMPurify\.sanitize/,
  'blog result must sanitize candidates through a dedicated helper');
assert.match(infoPage, /const sanitizedHtml = computed\(\(\) =>[\s\S]*sanitizeArticleCandidate\(candidate\)/,
  'blog result computed viewer must use the safe sanitizer helper');
assert.match(infoPage, /<article[^>]+v-html="sanitizedHtml"/,
  'blog result must use the same direct article viewer as the working link page');
assert(!/<iframe[^>]+:srcdoc="sanitizedHtml"/.test(infoPage),
  'blog result must not use the incompatible iframe viewer');

console.log('task center and blog viewer contract: OK');
