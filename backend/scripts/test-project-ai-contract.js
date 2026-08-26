'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const page = read('frontend/src/views/ProjectDetailPage.vue');
const controller = read('backend/src/controllers/projects.controller.js');
const runner = read('backend/src/services/projects/analysisRunner.js');
const analyst = read('backend/src/services/projects/llmAnalyst.js');
const projectConfig = read('backend/src/services/projects/config.js');
const worker = read('backend/src/queue/projectReportWorker.js');

const checks = [
  ['common AI button is visible with GSC or Yandex', () => assert.match(page, /v-if="gscReady \|\| ydxReady"/)],
  ['common AI button calls runAnalysis', () => assert.match(page, /@click="runAnalysis"/)],
  ['Yandex-only analysis is accepted by controller', () => assert.match(controller, /hasYdx = Boolean\(project\.ydx_connected/)],
  ['analysis is durably enqueued', () => assert.match(controller, /queueName: 'project-analysis'/)],
  ['runner chooses regular or batched analysis', () => assert.match(runner, /runProjectAnalysisBatched\(payload\)/)],
  ['runner persists final model', () => assert.match(runner, /llm_model = \$4/)],
  ['provider defaults to Gemini', () => assert.match(projectConfig, /provider:\s*'gemini'/)],
  ['Gemini model is configured', () => assert.match(projectConfig, /model:\s*'gemini-3\.1-pro-preview'/)],
  ['DeepSeek remains fallback', () => assert.match(analyst, /if \(_hasDeepSeek\(\)\) return 'deepseek'/)],
  ['project-analysis worker exists', () => assert.match(worker, /project-analysis/)],
  ['auxiliary AI cards remain wired', () => {
    for (const name of ['LinkProfileCard', 'BlogTopicsCard', 'MetaSuggestionsCard', 'AiVisibilityCard']) {
      assert.match(page, new RegExp(`<${name}\\b`), `${name} is wired`);
    }
  }],
];

for (const [name, fn] of checks) {
  fn();
  console.log(`  ✓ ${name}`);
}
console.log(`project AI contract: ${checks.length}/${checks.length} passed`);
