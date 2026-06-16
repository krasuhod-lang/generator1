'use strict';

/* Tests for reports/forecastEngine.forecastMetric. */

const assert = require('assert');
const { forecastMetric } = require('../src/services/reports/forecastEngine');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n        ', e.message); }
}

test('linear monotonic series — forecast continues uptrend', () => {
  const out = forecastMetric([100, 200, 300, 400, 500], 3);
  assert.strictEqual(out.method, 'poly2');
  assert.strictEqual(out.forecast.length, 3);
  // Must be strictly increasing for clearly increasing input.
  assert.ok(out.forecast[0] >= 500, `expected >= 500, got ${out.forecast[0]}`);
  assert.ok(out.forecast[1] > out.forecast[0]);
  assert.ok(out.forecast[2] > out.forecast[1]);
});

test('flat series — forecast stays near constant', () => {
  const out = forecastMetric([200, 200, 200, 200], 3);
  for (const v of out.forecast) {
    assert.ok(Math.abs(v - 200) < 5, `expected ~200, got ${v}`);
  }
});

test('decreasing trend cannot go below 0', () => {
  const out = forecastMetric([100, 80, 60, 40, 20, 5], 6);
  for (const v of out.forecast) {
    assert.ok(v >= 0, `expected ≥0, got ${v}`);
  }
});

test('insufficient data — returns zeros and method=insufficient', () => {
  const out = forecastMetric([], 3);
  assert.strictEqual(out.method, 'insufficient');
  assert.deepStrictEqual(out.forecast, [0, 0, 0]);

  const out1 = forecastMetric([42], 3);
  assert.strictEqual(out1.method, 'insufficient');
});

test('two points use linear extrapolation', () => {
  const out = forecastMetric([100, 200], 2);
  assert.strictEqual(out.method, 'linear');
  // After [100,200], slope=100, next two: 300, 400.
  assert.strictEqual(out.forecast[0], 300);
  assert.strictEqual(out.forecast[1], 400);
});

test('horizon clamped to [1..12]', () => {
  // 0 is falsy → falls back to default (3).
  assert.strictEqual(forecastMetric([1, 2, 3], 0).forecast.length, 3);
  assert.strictEqual(forecastMetric([1, 2, 3], 99).forecast.length, 12);
  assert.strictEqual(forecastMetric([1, 2, 3], -5).forecast.length, 1);
  assert.strictEqual(forecastMetric([1, 2, 3], 1).forecast.length, 1);
});

test('rounds to 2 decimals', () => {
  const out = forecastMetric([0.1, 0.2, 0.3, 0.4], 1);
  // value should not exceed 2 decimal precision
  const s = String(out.forecast[0]);
  if (s.includes('.')) {
    assert.ok(s.split('.')[1].length <= 2, `too many decimals: ${s}`);
  }
});

test('NaN and string inputs are coerced to 0', () => {
  const out = forecastMetric([10, 'abc', NaN, 40, 50], 1);
  assert.ok(Number.isFinite(out.forecast[0]));
  assert.ok(out.forecast[0] >= 0);
});

test('historical echoes input length', () => {
  const out = forecastMetric([10, 20, 30, 40], 2);
  assert.strictEqual(out.historical.length, 4);
  assert.strictEqual(out.basis, 4);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
