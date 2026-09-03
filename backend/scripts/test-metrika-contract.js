'use strict';

const assert = require('assert');
const { _internal, normalizeCounterId, resolveRange } = require('../src/services/projects/metrikaService');

const metrics = [
  'ym:s:visits',
  'ym:s:users',
  'ym:s:pageviews',
  'ym:s:bounceRate',
  'ym:ev:anyGoalReaches',
  'ym:ev:anyGoalConversionRate',
];

const rows = _internal.mapDailyRows({
  data: [
    { dimensions: [{ name: '2026-04-01' }], metrics: [10, 8, 14, 40, 2, 20] },
    { dimensions: [{ name: '2026-04-02' }], metrics: [20, 15, 30, 50, 3, 15] },
  ],
}, metrics);
assert.strictEqual(rows.length, 2);
assert.deepStrictEqual(rows[0], {
  date: '2026-04-01', visits: 10, users: 8, pageviews: 14,
  bounce_rate: 40, conversions: 2, conversion_rate: 20,
});

const monthSeries = _internal.aggregateSeries(rows, 'month');
assert.strictEqual(monthSeries.length, 1);
assert.deepStrictEqual(monthSeries[0], {
  date: '2026-04', visits: 30, users: 23, pageviews: 44,
  conversions: 5, bounce_rate: 46.67, conversion_rate: 16.67,
});

const totals = _internal.aggregateTotals(rows);
assert.deepStrictEqual(totals, {
  visits: 30, users: 23, pageviews: 44, conversions: 5,
  bounce_rate: 46.67, conversion_rate: 16.67,
});

const sourceMetrics = ['ym:s:visits', 'ym:s:users', 'ym:ev:anyGoalReaches', 'ym:ev:anyGoalConversionRate'];
const sources = _internal.mapSourceRows({
  data: [
    { dimensions: [{ name: 'Поиск' }], metrics: [100, 80, 10, 10] },
    { dimensions: [{ name: 'Переходы по ссылкам' }], metrics: [50, 40, 12, 24] },
  ],
}, sourceMetrics);
assert.strictEqual(sources[0].source, 'Поиск');
assert.strictEqual(sources[0].conversions, 10);
assert.strictEqual(normalizeCounterId('12345678'), '12345678');
assert.strictEqual(normalizeCounterId('abc'), '');
assert.strictEqual(normalizeCounterId('123456789012345678901'), '');
const resolved = resolveRange({ days: 28 });
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(resolved.from));
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(resolved.to));
assert.ok(resolved.from <= resolved.to);
console.log('METRIKA_CONTRACT_OK checks=18');
