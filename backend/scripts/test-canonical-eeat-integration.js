'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/146_canonical_eeat_quality.sql');
const orchestrator = read('backend/src/services/pipeline/orchestrator.js');
const controller = read('backend/src/controllers/tasks.controller.js');
const policy = read('backend/src/services/access/entitlementPolicy.js');
const qualityGate = read('backend/src/services/qualityCore/qualityGate.js');
const resultPage = read('frontend/src/views/ResultPage.vue');
const resultModal = read('frontend/src/components/ResultModal.vue');

const checks = [
  ['migration adds nullable canonical score/status/coverage', () => {
    assert.match(migration, /ADD COLUMN IF NOT EXISTS eeat_score_12 NUMERIC/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS eeat_score_12_status/);
    assert.match(migration, /ADD COLUMN IF NOT EXISTS eeat_score_12_coverage/);
  }],
  ['migration preserves legacy fields by additive-only DDL', () => {
    assert.doesNotMatch(migration, /DROP COLUMN|TRUNCATE|DELETE FROM/i);
  }],
  ['orchestrator computes canonical score and persists it separately', () => {
    assert.match(orchestrator, /computeCanonicalEeatScore/);
    assert.match(orchestrator, /eeat_score_12 = \$1/);
    assert.match(orchestrator, /quality_score_version = \$9/);
  }],
  ['orchestrator keeps legacy quality gate and Stage 7 fields', () => {
    assert.match(orchestrator, /eeat12:\s+eeat12Audit/);
    assert.match(orchestrator, /quality_gate = \$1/);
    assert.match(orchestrator, /globalEEATScore/);
  }],
  ['result API returns quality gate and canonical metrics', () => {
    assert.match(controller, /quality_gate:\s+isClientRequest\(req\)/);
    assert.match(controller, /eeat_score_12/);
  }],
  ['client projection hides raw quality gate blockers and errors', () => {
    assert.match(policy, /function sanitizeQualityGateForClient/);
    assert.doesNotMatch(policy.slice(policy.indexOf('function sanitizeQualityGateForClient'), policy.indexOf('function sanitizeMetricsForClient')), /blockers|error_message|components:/);
  }],
  ['quality gate errors fail closed for publication', () => {
    assert.match(qualityGate, /quality_gate_status: 'error'/);
    assert.match(qualityGate, /canPublish: false/);
  }],
  ['both result UIs use canonical E-E-A-T and separate Stage 7 PQ', () => {
    assert.match(resultPage, /E-E-A-T 12/);
    assert.match(resultPage, /Stage 7/);
    assert.match(resultModal, /E-E-A-T 12/);
    assert.match(resultModal, /Stage 7 PQ/);
  }],
];

let passed = 0;
for (const [name, run] of checks) {
  run();
  passed += 1;
  console.log(`✓ ${name}`);
}
console.log(`\n${passed} canonical integration checks passed`);
