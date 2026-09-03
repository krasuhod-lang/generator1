#!/usr/bin/env node
'use strict';

const { buildHeadline } = require('../src/services/reports/headlineBuilder');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const context = {
  comparison: {
    status: 'available',
    current: { from: '2026-06-01', to: '2026-06-30' },
    previous: { from: '2026-05-02', to: '2026-05-31' },
  },
};

const comparable = buildHeadline({
  report_context: context,
  gsc: {
    totals_complete: { clicks: 100, impressions: 1000 },
    prev_totals_complete: { clicks: 50, impressions: 500 },
    comparison: { status: 'available' },
  },
  ywm: {
    totals_complete: { clicks: 200, impressions: 2000 },
    prev_totals_complete: { clicks: 100, impressions: 1000 },
    comparison: { status: 'available' },
  },
}, null, context);
assert(comparable.main_kpi.value === 300, 'headline must sum complete current clicks');
assert(comparable.delta.status === 'available', 'headline comparison must be available');
assert(comparable.delta.abs === 150, 'headline delta must use explicit previous totals');
assert(comparable.comparison.previous.from === '2026-05-02', 'headline must preserve exact comparison range');

const missingComparison = buildHeadline({
  gsc: {
    totals_complete: { clicks: 100 },
    comparison: { status: 'no_comparison' },
  },
  ywm: {
    totals_complete: { clicks: 200 },
    comparison: { status: 'no_comparison' },
  },
});
assert(missingComparison.delta.status === 'no_comparison', 'missing comparison must not become stable');
assert(missingComparison.change_summary.includes('Нет данных для сравнения'), 'no-comparison copy must be explicit');

const keys = buildHeadline({
  keys_so: {
    yandex: {
      current: { visibility: 24 },
      comparison: { status: 'no_comparison' },
    },
  },
});
assert(keys.main_kpi.value === 24, 'Keys.so index must remain numeric');
assert(keys.main_kpi.unit === '', 'Keys.so index must not be labelled as percent');

console.log('REPORT_PERIOD_CONTEXT_OK checks=10');
