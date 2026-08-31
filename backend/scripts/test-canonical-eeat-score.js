'use strict';

const assert = require('assert');
const {
  EEAT_CRITERIA,
  EEAT_WEIGHTS,
  computeCanonicalEeatScore,
  aggregateBlockQuality,
} = require('../src/services/qualityLayers/canonicalEeatScore');
const { sanitizeQualityGateForClient } = require('../src/services/access/entitlementPolicy');

function makeAudit(score = 8) {
  return {
    components: Object.fromEntries(EEAT_CRITERIA.map((key) => [key, {
      score,
      status: 'measured',
      evidence_ids: [`ev-${key}`],
      confidence: 0.9,
      reason: 'test evidence',
    }])),
    blockers: [],
    unsupported_claims: [],
  };
}

function makeContract(overrides = {}) {
  return {
    risk_level: 'low',
    target_score: 7.5,
    human_review_required: false,
    format: { require_reviewer: false },
    ...overrides,
  };
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

check('weights sum to exactly 1.0 and expose 12 criteria', () => {
  assert.strictEqual(EEAT_CRITERIA.length, 12);
  assert.ok(Math.abs(Object.values(EEAT_WEIGHTS).reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
});

check('all measured produces canonical 8.00 and full coverage', () => {
  const result = computeCanonicalEeatScore(makeAudit(8), makeContract());
  assert.strictEqual(result.score, 8);
  assert.strictEqual(result.status, 'measured');
  assert.strictEqual(result.coverage, 1);
  assert.strictEqual(result.criteria_measured, 11); // reviewer is N/A for low-risk
  assert.strictEqual(result.publishable, true);
});

check('unavailable audit produces null, unavailable, and no publish', () => {
  const result = computeCanonicalEeatScore(null, makeContract());
  assert.strictEqual(result.score, null);
  assert.strictEqual(result.status, 'unavailable');
  assert.strictEqual(result.publishable, false);
});

check('one unavailable criterion produces partial rather than numeric zero', () => {
  const audit = makeAudit(8);
  audit.components.factual_accuracy = { score: null, status: 'unavailable' };
  const result = computeCanonicalEeatScore(audit, makeContract());
  assert.strictEqual(result.score, 8);
  assert.strictEqual(result.status, 'partial');
  assert.strictEqual(result.components.factual_accuracy.score, null);
  assert.strictEqual(result.publishable, false);
});

check('YMYL reviewer and critical evidence gates block publication', () => {
  const result = computeCanonicalEeatScore(
    makeAudit(8),
    makeContract({ risk_level: 'ymyl', human_review_required: true, format: { require_reviewer: true } }),
  );
  assert.strictEqual(result.status, 'human_review');
  assert.strictEqual(result.publishable, false);
  assert.ok(result.hard_gates.blockers.includes('reviewer_required_for_ymyl'));
});

check('critical block floor prevents masking by a high weighted mean', () => {
  const aggregate = aggregateBlockQuality([
    { block_id: 'block_1', pq_score: 9.5, plain_chars: 5000, critical: false },
    { block_id: 'block_2', pq_score: 5.5, plain_chars: 500, critical: true },
  ], 7.5);
  assert.ok(aggregate.weighted_score > 8);
  assert.strictEqual(aggregate.critical_floor, 5.5);
  assert.strictEqual(aggregate.status, 'measured');
  const result = computeCanonicalEeatScore(makeAudit(8), makeContract(), null, aggregate);
  assert.ok(result.hard_gates.blockers.includes('critical_block_floor_below_target'));
  assert.strictEqual(result.publishable, false);
});

check('partial block aggregate is surfaced separately from score', () => {
  const aggregate = aggregateBlockQuality([
    { block_id: 'block_1', pq_score: null, plain_chars: 1000, critical: true },
    { block_id: 'block_2', pq_score: 8, plain_chars: 1000, critical: false },
  ]);
  assert.strictEqual(aggregate.status, 'partial');
  assert.strictEqual(aggregate.coverage, 0.5);
  assert.deepStrictEqual(aggregate.unavailable_blocks, ['block_1']);
});

check('client quality gate projection excludes raw audit details', () => {
  const safe = sanitizeQualityGateForClient({
    canPublish: false,
    quality_gate_status: 'error',
    error_message: 'internal stack',
    blockers: [{ name: 'internal', verdict: 'secret' }],
    eeat_canonical: {
      score: 7.8,
      status: 'partial',
      coverage: 0.9,
      score_version: 'eeat12.v2',
      components: { factual_accuracy: { score: 5, evidence_ids: ['secret-id'] } },
      criteria_measured: 11,
      criteria_total: 12,
    },
    content_quality: { score: 82, status: 'measured', coverage: 1 },
  });
  assert.strictEqual(safe.eeat.score, 7.8);
  assert.strictEqual(safe.eeat.status, 'partial');
  assert.strictEqual(safe.eeat.coverage, 0.9);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(safe, 'blockers'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(safe, 'error_message'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(safe.eeat, 'components'), false);
});

console.log(`\n${passed} canonical E-E-A-T checks passed`);
if (process.exitCode) process.exit(1);
