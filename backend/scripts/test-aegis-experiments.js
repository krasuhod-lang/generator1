#!/usr/bin/env node
'use strict';

/**
 * Smoke-tests for aegis/experimentLoop (B4) — pure functions:
 *   binaryEntropy, uncertaintyFromConfidence, strikingDistanceScore,
 *   composeUncertainty, computeExperimentReward, classifyOutcome.
 * Не требует БД и сети.
 */

const assert = require('assert');
const exp = require('../src/services/aegis/experimentLoop');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✅ ${name}`); passed++; }
  catch (e) { console.error(`❌ ${name}\n   ${e.message}`); failed++; }
}

// ── binaryEntropy ─────────────────────────────────────────────────────
test('binaryEntropy: max at p=0.5', () => {
  assert.strictEqual(exp.binaryEntropy(0.5), 1);
});
test('binaryEntropy: zero at extremes', () => {
  assert.strictEqual(exp.binaryEntropy(0), 0);
  assert.strictEqual(exp.binaryEntropy(1), 0);
});
test('binaryEntropy: clamps out-of-range', () => {
  assert.strictEqual(exp.binaryEntropy(-1), 0);
  assert.strictEqual(exp.binaryEntropy(2), 0);
});
test('binaryEntropy: symmetric', () => {
  assert.strictEqual(exp.binaryEntropy(0.3), exp.binaryEntropy(0.7));
});

// ── uncertaintyFromConfidence ─────────────────────────────────────────
test('uncertaintyFromConfidence: confidence=1 → 0', () => {
  assert.strictEqual(exp.uncertaintyFromConfidence(1), 0);
});
test('uncertaintyFromConfidence: confidence=0 → 1', () => {
  assert.strictEqual(exp.uncertaintyFromConfidence(0), 1);
});
test('uncertaintyFromConfidence: missing → 0.5 (neutral)', () => {
  assert.strictEqual(exp.uncertaintyFromConfidence(null), 0.5);
  assert.strictEqual(exp.uncertaintyFromConfidence(undefined), 0.5);
  assert.strictEqual(exp.uncertaintyFromConfidence('x'), 0.5);
});

// ── strikingDistanceScore ─────────────────────────────────────────────
test('strikingDistance: peak at 11..20', () => {
  const peak = exp.strikingDistanceScore(15);
  assert.ok(peak === 1.0);
  assert.ok(exp.strikingDistanceScore(2) < peak);
  assert.ok(exp.strikingDistanceScore(60) < peak);
});
test('strikingDistance: invalid → 0', () => {
  assert.strictEqual(exp.strikingDistanceScore(null), 0);
  assert.strictEqual(exp.strikingDistanceScore(0), 0);
  assert.strictEqual(exp.strikingDistanceScore(-3), 0);
});

// ── composeUncertainty ────────────────────────────────────────────────
test('composeUncertainty: striking-distance dominates when biobrain neutral', () => {
  const high = exp.composeUncertainty({ confidence: null, position: 15, priority: 0 });
  const low  = exp.composeUncertainty({ confidence: null, position: 1,  priority: 0 });
  assert.ok(high > low, `${high} should be > ${low}`);
});
test('composeUncertainty: bounded [0,1]', () => {
  const r = exp.composeUncertainty({ confidence: 0, position: 15, priority: 100 });
  assert.ok(r >= 0 && r <= 1, `out of range: ${r}`);
});
test('composeUncertainty: high priority lifts score', () => {
  const a = exp.composeUncertainty({ confidence: 0.5, position: 5, priority: 0 });
  const b = exp.composeUncertainty({ confidence: 0.5, position: 5, priority: 9 });
  assert.ok(b > a);
});

// ── computeExperimentReward ───────────────────────────────────────────
test('reward: pos 20→3 + clicks gain → high', () => {
  const r = exp.computeExperimentReward({ baselinePosition: 20, postPosition: 3, deltaClicks: 50 });
  assert.ok(r > 0.7, `reward too low: ${r}`);
});
test('reward: pos 5→25 (deteriorated) → low', () => {
  const r = exp.computeExperimentReward({ baselinePosition: 5, postPosition: 25, deltaClicks: -10 });
  assert.ok(r < 0.4, `reward too high: ${r}`);
});
test('reward: missing post → finite, 0..1', () => {
  const r = exp.computeExperimentReward({ baselinePosition: 10 });
  assert.ok(Number.isFinite(r) && r >= 0 && r <= 1);
});

// ── classifyOutcome ──────────────────────────────────────────────────
test('outcome: position improved & high reward → won', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.8, deltaPosition: -5 }), 'won');
});
test('outcome: position worsened → lost', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.5, deltaPosition: +3 }), 'lost');
});
test('outcome: very low reward → lost', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.1, deltaPosition: -1 }), 'lost');
});
test('outcome: small movement → inconclusive', () => {
  assert.strictEqual(exp.classifyOutcome({ reward: 0.4, deltaPosition: -0.2 }), 'inconclusive');
});
test('outcome: nulls → inconclusive', () => {
  assert.strictEqual(exp.classifyOutcome({}), 'inconclusive');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
