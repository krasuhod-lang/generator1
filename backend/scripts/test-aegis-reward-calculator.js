'use strict';

/**
 * Тесты для aegis/rewardCalculator.js (задача 2).
 * Чистые функции — без БД.
 *
 * Запуск: node backend/scripts/test-aegis-reward-calculator.js
 */

const assert = require('assert');
const {
  computeProjectReward,
  computeGenerationReward,
  _internal,
} = require('../src/services/aegis/rewardCalculator');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.message}`); }
}

console.log('rewardCalculator');

test('_tanh: 0 → 0, +∞ → 1, -∞ → -1', () => {
  assert.strictEqual(_internal._tanh(0), 0);
  assert.ok(_internal._tanh(100) > 0.999);
  assert.ok(_internal._tanh(-100) < -0.999);
});

test('_clamp01 ограничивает [0..1]', () => {
  assert.strictEqual(_internal._clamp01(-1), 0);
  assert.strictEqual(_internal._clamp01(0.5), 0.5);
  assert.strictEqual(_internal._clamp01(2), 1);
  assert.strictEqual(_internal._clamp01('bad'), 0);
});

test('computeProjectReward: пустые фичи дают reward = 0', () => {
  const r = computeProjectReward({});
  assert.strictEqual(r.reward, 0);
  assert.ok(r.breakdown);
});

test('computeProjectReward: положительная динамика → положительный reward', () => {
  const r = computeProjectReward({
    deltaClicks: 500, deltaPosition: -2, spq: 80, ctrGapClosed: 0.5, budgetUsd: 1,
  });
  assert.ok(r.reward > 0, `expected >0, got ${r.reward}`);
  assert.ok(r.breakdown.deltaClicks   > 0);
  assert.ok(r.breakdown.deltaPosition > 0); // позиция упала = хорошо
  assert.ok(r.breakdown.spq           > 0);
  assert.ok(r.breakdown.ctrGapClosed  > 0);
  assert.ok(r.breakdown.budgetUsd     < 0); // расход — штраф
});

test('computeProjectReward: рост позиции (хуже) → штраф по позиции', () => {
  const r = computeProjectReward({ deltaPosition: 3 });
  assert.ok(r.breakdown.deltaPosition < 0);
});

test('computeProjectReward: огромный Δclicks не доминирует (tanh насыщается)', () => {
  const big   = computeProjectReward({ deltaClicks: 1e9 });
  const small = computeProjectReward({ deltaClicks: 200 });
  assert.ok(big.breakdown.deltaClicks - small.breakdown.deltaClicks < 1,
    'tanh должен ограничивать вклад');
});

test('computeProjectReward: override весов работает', () => {
  const base = computeProjectReward({ spq: 100 });
  const x10  = computeProjectReward({ spq: 100 }, { weights: { spq: base.weights.spq * 10 } });
  assert.ok(x10.breakdown.spq > base.breakdown.spq * 5);
});

test('computeProjectReward: budgetUsd < 0 нормализуется в 0 (без штрафа)', () => {
  const r = computeProjectReward({ budgetUsd: -100 });
  assert.strictEqual(r.breakdown.budgetUsd + 0, 0);
});

test('computeGenerationReward: чистая статья → положительный reward', () => {
  const r = computeGenerationReward({ spq: 90, factCheckPassRate: 1.0, plagiarismOverlap: 0 });
  assert.ok(r.reward > 0);
  assert.strictEqual(r.breakdown.plagiarism + 0, 0);
});

test('computeGenerationReward: высокий плагиат → штраф', () => {
  const clean = computeGenerationReward({ spq: 90, factCheckPassRate: 1, plagiarismOverlap: 0 });
  const stol  = computeGenerationReward({ spq: 90, factCheckPassRate: 1, plagiarismOverlap: 1 });
  assert.ok(stol.reward < clean.reward);
});

test('computeProjectReward: NaN/undefined → 0, не падает', () => {
  const r = computeProjectReward({ deltaClicks: NaN, spq: undefined, ctrGapClosed: 'bad' });
  assert.ok(Number.isFinite(r.reward));
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
