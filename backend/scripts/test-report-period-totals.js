'use strict';

/**
 * test-report-period-totals.js — юнит-тесты helper'ов dataAggregator,
 * связанных с полными/неполными периодами (ТЗ §2-3).
 *
 * Запуск:  node backend/scripts/test-report-period-totals.js
 */

const assert = require('assert');
const {
  _seriesMeta,
  _totalsFromMonths,
  _completePeriodTotals,
} = require('../src/services/reports/dataAggregator');

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

function _dailyRange(from, to, perDay = { clicks: 10, impressions: 100, ctr: 10, position: 5 }) {
  const out = [];
  const d = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  while (d.getTime() <= end.getTime()) {
    out.push({ date: d.toISOString().slice(0, 10), ...perDay });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

console.log('── _seriesMeta ──');
test('пустая серия', () => {
  const meta = _seriesMeta([]);
  assert.deepStrictEqual(meta.monthly_periods, []);
  assert.strictEqual(meta.last_period_partial, false);
  assert.strictEqual(meta.last_complete_month, null);
  assert.strictEqual(meta.complete_months, 0);
});

test('один полный месяц + один неполный', () => {
  const today = new Date();
  const yearMonth = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const lastDayPrev = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  const fmt = (d) => d.toISOString().slice(0, 10);
  // Прошлый месяц (точно полный) + первые 5 дней текущего (неполный).
  const series = [
    ..._dailyRange(fmt(yearMonth), fmt(lastDayPrev)),
    ..._dailyRange(
      fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
      fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 5))),
    ),
  ];
  const meta = _seriesMeta(series);
  assert.strictEqual(meta.monthly_periods.length, 2, 'два месяца');
  assert.strictEqual(meta.monthly_periods[0].is_complete, true);
  assert.strictEqual(meta.monthly_periods[1].is_partial, true);
  assert.strictEqual(meta.last_period_partial, true);
  assert.ok(meta.last_complete_month, 'есть last_complete_month');
  assert.strictEqual(meta.complete_months, 1);
});

console.log('── _totalsFromMonths ──');
test('null/empty → null', () => {
  assert.strictEqual(_totalsFromMonths([]), null);
  assert.strictEqual(_totalsFromMonths(null), null);
});

test('весь набор полных месяцев → суммируется корректно', () => {
  const totals = _totalsFromMonths([
    { clicks: 100, impressions: 1000, position: 5, days: 30 },
    { clicks: 200, impressions: 2000, position: 4, days: 31 },
  ]);
  assert.strictEqual(totals.clicks, 300);
  assert.strictEqual(totals.impressions, 3000);
  assert.strictEqual(totals.ctr, 10);          // 300/3000 * 100
  // Взвешенная позиция: (5*30 + 4*31)/(30+31) ≈ 4.49
  assert.ok(Math.abs(totals.position - 4.49) < 0.02, `pos=${totals.position}`);
  assert.strictEqual(totals.months_count, 2);
});

console.log('── _completePeriodTotals ──');
test('без полных месяцев → totals_complete = null', async () => {
  // Окно из 5 дней текущего месяца → ни одного полного месяца.
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const series = _dailyRange(
    fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1))),
    fmt(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 5))),
  );
  const res = await _completePeriodTotals(series, null);
  assert.strictEqual(res.totals_complete, null);
  assert.strictEqual(res.prev_totals_complete, null);
  assert.strictEqual(res.meta.complete_months, 0);
});

test('один полный месяц + fetcher отдаёт пред. период', async () => {
  // Прошлый месяц целиком + 3 дня текущего.
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const prevStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const prevEnd   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  const curStart  = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const curEnd    = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 3));
  const series = [
    ..._dailyRange(fmt(prevStart), fmt(prevEnd)),
    ..._dailyRange(fmt(curStart),  fmt(curEnd)),
  ];
  // Имитируем fetcher для пред. периода: пред-прошлый месяц.
  let fetcherCall = null;
  const fetcher = async (from, to) => {
    fetcherCall = { from, to };
    const f = new Date(`${from}T00:00:00Z`);
    const t = new Date(`${to}T00:00:00Z`);
    return _dailyRange(fmt(f), fmt(t), { clicks: 5, impressions: 50, ctr: 10, position: 6 });
  };
  const res = await _completePeriodTotals(series, fetcher);
  assert.ok(res.totals_complete, 'есть totals_complete');
  assert.strictEqual(res.totals_complete.months_count, 1);
  assert.ok(res.prev_totals_complete, 'есть prev_totals_complete');
  assert.strictEqual(res.prev_totals_complete.months_count, 1);
  assert.ok(fetcherCall, 'fetcher вызван');
});

test('fetcher бросает → graceful (totals_complete остаётся)', async () => {
  const today = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  const prevStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const prevEnd   = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
  const series = _dailyRange(fmt(prevStart), fmt(prevEnd));
  const fetcher = async () => { throw new Error('boom'); };
  const res = await _completePeriodTotals(series, fetcher);
  assert.ok(res.totals_complete);
  assert.strictEqual(res.prev_totals_complete, null);
});

console.log(`\nИтого: ${total - failed}/${total} тестов прошли.`);
if (failed) process.exit(1);
