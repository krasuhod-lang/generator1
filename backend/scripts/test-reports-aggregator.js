'use strict';

/* Tests for reports/dataAggregator._aggregateByMonth + integration shape. */

const assert = require('assert');
const { _aggregateByMonth } = require('../src/services/reports/dataAggregator');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n        ', e.message); }
}

test('groups daily rows into months and sums clicks', () => {
  const series = [
    { date: '2026-01-05', clicks: 10, impressions: 100, position: 5 },
    { date: '2026-01-20', clicks: 20, impressions: 200, position: 7 },
    { date: '2026-02-03', clicks: 30, impressions: 300, position: 4 },
  ];
  const m = _aggregateByMonth(series, ['clicks', 'impressions']);
  assert.strictEqual(m.length, 2);
  assert.strictEqual(m[0].date, '2026-01-01');
  assert.strictEqual(m[0].clicks, 30);
  assert.strictEqual(m[0].impressions, 300);
  // weighted ctr = 30/300 * 100 = 10%
  assert.strictEqual(m[0].ctr, 10);
  // avg position = 6
  assert.strictEqual(m[0].position, 6);
  assert.strictEqual(m[1].date, '2026-02-01');
  assert.strictEqual(m[1].clicks, 30);
});

test('sorts months chronologically', () => {
  const series = [
    { date: '2026-03-01', clicks: 1 },
    { date: '2026-01-01', clicks: 1 },
    { date: '2026-02-01', clicks: 1 },
  ];
  const m = _aggregateByMonth(series, ['clicks']);
  assert.deepStrictEqual(m.map((x) => x.date), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('skips rows without date', () => {
  const m = _aggregateByMonth([{ clicks: 99 }, { date: '2026-01-01', clicks: 1 }], ['clicks']);
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].clicks, 1);
});

test('handles empty input', () => {
  assert.deepStrictEqual(_aggregateByMonth([], ['clicks']), []);
  assert.deepStrictEqual(_aggregateByMonth(null, ['clicks']), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
