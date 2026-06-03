'use strict';

/**
 * test-projects-analytics.js — smoke-тесты pure-логики новых модулей
 * аналитики GSC: periodComparison, pageDecayDetector, brandSplit.
 *
 * Запуск: node backend/scripts/test-projects-analytics.js
 */

const assert = require('assert');
const {
  compareTotals,
  compareKeyed,
  buildPeriodReport,
} = require('../src/services/projects/periodComparison');
const {
  _isoWeekStart,
  linearRegression,
  groupByPageWeek,
  detectPageDecay,
} = require('../src/services/projects/pageDecayDetector');
const { splitQueries } = require('../src/services/projects/brandSplit');

let passed = 0; let failed = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else      { console.log(`  ✗ ${name}`); failed++; }
}

console.log('## periodComparison.compareTotals');
{
  const curr = { clicks: 1100, impressions: 11000, ctr: 10, position: 8.5 };
  const prev = { clicks: 1000, impressions: 10000, ctr: 10, position: 9.0 };
  const r = compareTotals(curr, prev);
  ok('delta.clicks = +100', r.delta.clicks === 100);
  ok('delta.impressions = +1000', r.delta.impressions === 1000);
  ok('delta.position improved by 0.5', r.delta.position === -0.5);
  // ΔClicks=100, ΔImpr=1000, CTRprev=0.1 → demand_contrib=100; ImprCurr=11000,
  // ΔCTR=0 → ctr_contrib=0; sum≈100.
  ok('demand_contrib ≈ 100', Math.abs(r.decomposition.demand_contrib_clicks - 100) < 0.01);
  ok('ctr_contrib ≈ 0', Math.abs(r.decomposition.ctr_contrib_clicks) < 0.01);
}
{
  const curr = { clicks: 800, impressions: 10000, ctr: 8, position: 9 };
  const prev = { clicks: 1000, impressions: 10000, ctr: 10, position: 9 };
  const r = compareTotals(curr, prev);
  ok('drop attributable to CTR', r.delta.clicks === -200
    && Math.abs(r.decomposition.demand_contrib_clicks) < 0.01
    && Math.abs(r.decomposition.ctr_contrib_clicks - (-200)) < 0.01);
}

console.log('## periodComparison.compareKeyed');
{
  const curr = [
    { key: 'a', clicks: 100, impressions: 1000, ctr: 10, position: 5 },
    { key: 'b', clicks: 50, impressions: 500, ctr: 10, position: 6 },
    { key: 'newbie', clicks: 30, impressions: 300, ctr: 10, position: 8 },
  ];
  const prev = [
    { key: 'a', clicks: 50, impressions: 800, ctr: 6.25, position: 6 },
    { key: 'b', clicks: 80, impressions: 700, ctr: 11.4, position: 5 },
    { key: 'lostie', clicks: 20, impressions: 200, ctr: 10, position: 9 },
  ];
  const r = compareKeyed(curr, prev, { minImpressions: 0, minClicksAbsDelta: 0, topN: 3 });
  ok('riser top is "a"', r.risers[0].key === 'a' && r.risers[0].delta.clicks === 50);
  ok('faller top is "b"', r.fallers[0].key === 'b' && r.fallers[0].delta.clicks === -30);
  ok('newcomer detected', r.newcomers.find((n) => n.key === 'newbie'));
  ok('lost detected', r.lost.find((l) => l.key === 'lostie'));
}

console.log('## periodComparison.buildPeriodReport — empty inputs');
{
  const r = buildPeriodReport({});
  ok('returns available:false on empty', r.available === false);
}

console.log('## pageDecayDetector._isoWeekStart');
{
  // 2026-06-03 is Wednesday → week starts 2026-06-01.
  ok('Wed → Mon of same week', _isoWeekStart('2026-06-03') === '2026-06-01');
  // Sunday 2026-06-07 → still Monday 2026-06-01.
  ok('Sun maps back to previous Mon', _isoWeekStart('2026-06-07') === '2026-06-01');
  ok('null on bad input', _isoWeekStart('') === null);
}

console.log('## pageDecayDetector.linearRegression');
{
  const w = [
    { week: '2026-04-06', clicks: 100 },
    { week: '2026-04-13', clicks: 80 },
    { week: '2026-04-20', clicks: 60 },
    { week: '2026-04-27', clicks: 40 },
  ];
  const r = linearRegression(w);
  ok('decreasing slope', r.slope < 0);
  ok('mean ≈ 70', r.mean === 70);
  ok('slope_norm ≈ -0.286', Math.abs(r.slope_norm + 0.286) < 0.01);
}

console.log('## pageDecayDetector.detectPageDecay');
{
  const rows = [];
  // Page A: decay (100 → 30 over 8 weeks)
  for (let w = 0; w < 8; w++) {
    rows.push({ page: '/a', date: _isoDateAddWeeks('2026-03-30', w), clicks: 100 - w * 10, impressions: 1000 });
  }
  // Page B: stable
  for (let w = 0; w < 8; w++) {
    rows.push({ page: '/b', date: _isoDateAddWeeks('2026-03-30', w), clicks: 50, impressions: 500 });
  }
  const r = detectPageDecay(rows, {
    minWeeks: 4, slopeThreshold: -0.05, minMeanWeeklyClicks: 5, topPages: 10,
  });
  ok('A flagged decaying', r.items.find((it) => it.page === '/a' && it.decaying));
  ok('B not decaying', r.items.find((it) => it.page === '/b' && !it.decaying));
}

console.log('## brandSplit.splitQueries');
{
  const queries = [
    { key: 'купить acme pro', clicks: 100, impressions: 1000, ctr: 10, position: 3 },
    { key: 'acme отзывы', clicks: 50, impressions: 800, ctr: 6.25, position: 5 },
    { key: 'аренда оборудования москва', clicks: 30, impressions: 600, ctr: 5, position: 7 },
    { key: 'купить генератор недорого', clicks: 20, impressions: 400, ctr: 5, position: 9 },
  ];
  const r = splitQueries(queries, ['acme']);
  ok('available', r.available === true);
  ok('branded.clicks = 150', r.branded.clicks === 150);
  ok('nonbranded.clicks = 50', r.nonbranded.clicks === 50);
  ok('branded share 75%', r.branded.clicks_pct === 75);
  ok('flagged correctly', r.flagged_sample.find((f) => f.key === 'acme отзывы').branded === true);
  ok('non-brand flagged', r.flagged_sample.find((f) => f.key.startsWith('аренда')).branded === false);
}

function _isoDateAddWeeks(base, w) {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + w * 7);
  return d.toISOString().slice(0, 10);
}

console.log('');
console.log(`Passed: ${passed}, Failed: ${failed}`);
if (failed > 0) process.exit(1);
