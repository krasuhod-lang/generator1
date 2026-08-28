'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const tasksController = read('src/controllers/tasks.controller.js');
const tasksStore = fs.readFileSync(
  path.resolve(root, '../frontend/src/stores/tasks.js'),
  'utf8',
);
const relevanceClient = read('src/services/relevance/pythonClient.js');
const tzDeriver = read('src/services/tz/tzFieldDeriver.js');

assert.match(tasksController, /timeoutMs:\s*TZ_LLM_TIMEOUT_MS[\s\S]*stageName:\s*'tz_extractor'/);
assert.match(tasksController, /const TZ_LLM_TIMEOUT_MS\s*=\s*300000/);
assert.match(tasksController, /maxTokens:\s*8000[\s\S]*timeoutMs:\s*300000[\s\S]*retries:\s*1/);
assert.match(tasksStore, /parse-tz[\s\S]*timeout:\s*0/);
assert.match(tasksStore, /relevance-prefill[\s\S]*timeout:\s*360000/);
assert.match(relevanceClient, /v\s*>=\s*10000\s*&&\s*v\s*<=\s*600000/);
assert.match(relevanceClient, /timeout:\s*ANALYZE_TIMEOUT_MS/);
assert.match(tzDeriver, /const TIMEOUT_MS\s*=\s*180000/);

// The exact obsolete cap must not remain in the relevance-prefill enrichment.
const prefillSection = tasksController.slice(
  tasksController.indexOf('async function _runRelevanceLlmEnrichment'),
  tasksController.indexOf('async function getRelevancePrefill'),
);
assert.ok(prefillSection.includes('timeoutMs:   300000'));
assert.ok(!prefillSection.includes('timeoutMs:   120000'));

console.log('analysis timeout contract: 10/10 checks passed');
