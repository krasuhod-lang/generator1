'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const callLLM = read('src/services/llm/callLLM.js');
assert.match(callLLM, /repairOnJsonError = false/);
assert.match(callLLM, /repairMaxTokens = 4096/);
assert.match(callLLM, /JSON parse failed — bounded repair/);
assert.match(callLLM, /repaired_json/);
assert.match(callLLM, /retryOnTruncation: false/);

for (const file of [
  'src/services/pipeline/stage0.js',
  'src/services/pipeline/stage1.js',
  'src/services/pipeline/stage2.js',
  'src/services/pipeline/stage4.js',
  'src/services/pipeline/stage5.js',
  'src/services/pipeline/stage6.js',
  'src/services/pipeline/stage7.js',
  'src/services/pipeline/stage8.js',
]) {
  const source = read(file);
  assert.match(source, /repairOnJsonError:\s*true/, `${file} must opt into bounded JSON repair`);
}

const researchProvider = read('src/services/llm/researchProvider.js');
assert.match(researchProvider, /configuredRetries/);
assert.match(researchProvider, /retries,\n\s+temperature/);
assert.doesNotMatch(researchProvider, /\.\.\.callOptions,[\s\S]{0,100}retries:\s*2/);

const qwen = read('src/services/llm/qwenAgent.adapter.js');
assert.match(qwen, /DEFAULT_TIMEOUT_MS = 90 \* 1000/);
assert.match(qwen, /qwenCircuitOpenUntil/);
assert.match(qwen, /requestStatus: 'circuit_open'/);
assert.match(qwen, /QWEN_CIRCUIT_COOLDOWN_MS/);
assert.match(qwen, /onTokens\('qwen', metrics\.tokensIn, metrics\.tokensOut/);

const stage3 = read('src/services/pipeline/stage3.js');
const stage4 = read('src/services/pipeline/stage4.js');
const stage6 = read('src/services/pipeline/stage6.js');
const stage7 = read('src/services/pipeline/stage7.js');
const worker = read('src/queue/worker.js');
const stage5 = read('src/services/pipeline/stage5.js');
assert.match(stage5, /currentPQ < previousPQ - 0\.5/);
assert.match(stage5, /best-so-far/);
assert.match(stage5, /непроверенный последний кандидат отклонён/);
assert.match(stage6, /nextCoverage\.percent <= coverage\.percent/);
assert.match(stage6, /сохранён best-so-far/);
assert.match(stage7, /contentSaved: true/);
assert.match(stage7, /Number\(contentUpdate\.rowCount\) < 1/);
assert.match(worker, /pipelineResult\?\.contentSaved !== true/);
const orchestrator = read('src/services/pipeline/orchestrator.js');
assert.match(orchestrator, /pipeline_completed: true/);
assert.match(orchestrator, /content_saved: true/);
assert.match(orchestrator, /publishable: gateResult\.canPublish && eeat12Ready/);
assert.match(orchestrator, /provider === 'qwen' \? 'qwen'/);
const entitlementPolicy = read('src/services/access/entitlementPolicy.js');
assert.match(entitlementPolicy, /function sanitizeQualityGateForClient/);
assert.doesNotMatch(entitlementPolicy, /return \{[\s\S]{0,500}pipeline_completed/);
assert.match(stage3, /buildBlockHandoffPrompt/);
assert.match(stage4, /buildBlockHandoffPrompt/);
assert.match(stage7, /VERIFIED CONTENT HANDOFF SUMMARY/);

console.log('bounded recovery contract: OK');
