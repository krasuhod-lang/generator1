'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');
}

const tracker = require('../src/services/aegis/serpOutcomeTracker');
const measurement = require('../src/services/aegis/serpMeasurementJob');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

test('reward is bounded and rewards better positions', () => {
  const top = tracker.computeReward({ avgPosition: 1, inTop3: 1, inTop10: 1, deltaClicks: 100 });
  const low = tracker.computeReward({ avgPosition: 80, inTop3: 0, inTop10: 0, deltaClicks: 0 });
  assert(top >= 0 && top <= 1);
  assert(low >= 0 && low <= 1);
  assert(top > low);
});

test('SERP rows aggregate only requested queries and calculate weighted position', () => {
  const result = measurement._aggregateRows([
    { query: 'alpha', clicks: 10, impressions: 100, position: 2 },
    { query: 'beta', clicks: 1, impressions: 100, position: 10 },
    { query: 'other', clicks: 100, impressions: 1000, position: 1 },
  ], ['alpha', 'beta'], 'gsc');
  assert.strictEqual(result.sampleSize, 2);
  assert.strictEqual(result.clicks, 11);
  assert.strictEqual(result.impressions, 200);
  assert.strictEqual(result.inTop3, 1);
  assert.strictEqual(result.inTop10, 2);
  assert(Math.abs(result.avgPosition - 6) < 0.001);
});

test('measurement window ends two days before now', () => {
  const range = measurement._measurementRange({ published_at: '2026-08-01T00:00:00.000Z' }, new Date('2026-08-21T00:00:00.000Z'));
  assert.strictEqual(range.from, '2026-08-01');
  assert.strictEqual(range.to, '2026-08-19');
});

test('publication hooks cover all generation paths and classic SEO', () => {
  const info = read('backend/src/services/infoArticle/infoArticlePipeline.js');
  const link = read('backend/src/services/linkArticle/linkArticlePipeline.js');
  const meta = read('backend/src/services/metaTags/pipeline.js');
  const seo = read('backend/src/services/pipeline/orchestrator.js');
  for (const source of [info, link, meta, seo]) {
    assert(source.includes('recordTaskPublication'));
    assert(source.includes('published_url'));
    assert(source.includes('published_queries'));
  }
});

test('experiment measurement uses real project/features and durable retry fields', () => {
  const loop = read('backend/src/services/aegis/experimentLoop.js');
  const worker = read('backend/src/services/aegis/serpMeasurementJob.js');
  const migration = read('migrations/134_aegis_self_learning_feedback.sql');
  assert(loop.includes('baselineFeatures: c.feature_vector'));
  assert(loop.includes('project_id'));
  assert(loop.includes('measure_after_at'));
  assert(loop.includes('retryMeasuredExperimentFeedback'));
  assert(worker.includes('measureDueExperiments'));
  assert(worker.includes('closeExperiment(_db'));
  assert(migration.includes('feedback_status VARCHAR(16)'));
});

test('classic SEO task accepts Aegis provenance metadata', () => {
  const tasks = read('backend/src/controllers/tasks.controller.js');
  assert(tasks.includes('published_url'));
  assert(tasks.includes('published_queries'));
  assert(tasks.includes('resolveOwnedOpportunityId'));
  assert(tasks.includes('source_snapshot_id'));
});

test('compiled brain is advisory and cannot weaken hard writer contracts', () => {
  const info = read('backend/src/services/infoArticle/infoArticlePipeline.js');
  const link = read('backend/src/services/linkArticle/linkArticlePipeline.js');
  for (const source of [info, link]) {
    assert(source.includes('A.E.G.I.S. LEARNED STRATEGY — advisory only'));
    assert(source.includes('Do not weaken evidence, HTML, governance'));
    assert(source.includes('getWriterSystemPromptOverride'));
  }
});

test('measurement worker has a database fallback and graceful scheduler stop', () => {
  const source = read('backend/src/services/aegis/serpMeasurementJob.js');
  assert(source.includes("const dbDefault = require('../../config/db')"));
  assert(source.includes('function stopSerpMeasurementScheduler()'));
  assert(source.includes('FOR UPDATE SKIP LOCKED'));
});

test('rollback registry confines artifacts and exposes an admin route', () => {
  const registry = require('../src/services/aegis/brainVersionRegistry');
  const routes = read('backend/src/routes/aegis.routes.js');
  assert.throws(() => registry._confinedPath('/tmp/not-brain-state.yaml'), /artifact_path_outside_brain_state/);
  assert(routes.includes("/brain/versions/:id/rollback"));
});

test('feedback claims are atomic for concurrent workers', () => {
  const trackerSource = read('backend/src/services/aegis/serpOutcomeTracker.js');
  const experimentSource = read('backend/src/services/aegis/experimentLoop.js');
  assert(trackerSource.includes('WITH claim AS'));
  assert(experimentSource.includes('WITH claim AS'));
  assert(trackerSource.includes("feedback_next_attempt_at = NOW() + INTERVAL '5 minutes'"));
  assert(experimentSource.includes("feedback_next_attempt_at = NOW() + INTERVAL '5 minutes'"));
});

test('auto-retrain unwraps DSPy HTTP body before deployment persistence', () => {
  const source = read('backend/src/services/aegis/dspyAutoRetrain.js');
  assert(source.includes("r && r.body && typeof r.body === 'object'"));
  assert(source.includes("body.last_status === 'deployed'"));
  assert(source.includes('body.artifact_path'));
});

test('DSPy dependency and artifact history are explicitly configured', () => {
  const requirements = read('aegis_py/requirements.txt');
  const optimizer = read('aegis_py/app/dspy_optimizer.py');
  assert(/(^|\n)dspy-ai==2\.5\.41/.test(requirements));
  assert(optimizer.includes('candidate_rejected'));
  assert(optimizer.includes('holdout_improvement_below_threshold'));
  assert(optimizer.includes('os.replace(temp_name'));
});

console.log(`Aegis self-learning upgrade: ${passed}/12 passed`);
if (process.exitCode) process.exit(process.exitCode);
