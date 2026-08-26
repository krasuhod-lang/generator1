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
const reliability = read('backend/src/services/tasks/reliability.js');
const worker = read('backend/src/queue/projectReportWorker.js');
const mainWorker = read('backend/src/queue/worker.js');

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
  ['main worker imports project-report workers', () => assert.match(mainWorker, /require\('\.\/projectReportWorker'\)/)],
  ['main worker starts project-report workers after schema', () => assert.match(mainWorker, /await startProjectReportWorkers\(\)/)],
  ['main worker requeues project-report work on shutdown', () => assert.match(mainWorker, /requeueProjectReportOwnedWork\(\)/)],
  ['project-report worker has shutdown requeue', () => assert.match(worker, /llm_status='queued'/) && assert.match(worker, /status='queued'/)],
  ['analysis has a hard total timeout', () => assert.match(projectConfig, /totalTimeoutMs:\s*55 \* 60 \* 1000/) && assert.match(runner, /projectAnalysis.*timedOut|timedOut.*projectAnalysis/)],
  ['expired project jobs are recovered and redispatched', () => assert.match(reliability, /project_analyses/) && assert.match(reliability, /queueName: 'project-analysis'/)],
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
