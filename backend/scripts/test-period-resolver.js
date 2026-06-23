'use strict';

/**
 * test-period-resolver.js — тесты детерминированного резолвера полных
 * периодов (ТЗ §5.1).
 *
 * Запуск: node backend/scripts/test-period-resolver.js
 * Coverage: describeMonth, resolveCompletedMonths, isPeriodComplete,
 * splitSeriesIntoMonths.
 */

const {
  describeMonth, resolveCompletedMonths, isPeriodComplete, splitSeriesIntoMonths,
} = require('../src/services/projects/periodResolver');

let pass = 0, fail = 0;

function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n    expected: ${e}\n    actual:   ${a}`); }
}
function truthy(cond, label) {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
}

console.log('=== describeMonth ===');
(() => {
  // 2025-06-15: июнь не закончился → partial.
  const r = describeMonth('2025-06-15', { now: '2025-06-15', lagDays: 3 });
  eq(r.key, '2025-06', 'June key');
  eq(r.from, '2025-06-01', 'June from');
  eq(r.to, '2025-06-30', 'June to');
  truthy(r.is_partial, 'June 2025 is partial (current month)');
  truthy(!r.is_complete, 'June 2025 is not complete');
})();
(() => {
  // Май 2025 на дату 2025-06-05, lag=3 → май закончился 2025-05-31,
  // прошло 5 дней >= 3 → полный.
  const r = describeMonth('2025-05-10', { now: '2025-06-05', lagDays: 3 });
  truthy(r.is_complete, 'May 2025 complete on 2025-06-05 with lag=3');
})();
(() => {
  // Май 2025 на дату 2025-06-02, lag=3 → прошло только 2 дня → partial.
  const r = describeMonth('2025-05-10', { now: '2025-06-02', lagDays: 3 });
  truthy(!r.is_complete, 'May 2025 still partial on 2025-06-02 with lag=3');
})();
(() => {
  // Май 2025, lag прошёл, но source_max_date=2025-05-25 (< 2025-05-31) → partial.
  const r = describeMonth('2025-05-10', {
    now: '2025-06-10', lagDays: 3, sourceMaxDate: '2025-05-25',
  });
  truthy(!r.is_complete, 'May 2025 still partial when source not covered');
})();
(() => {
  // Будущий месяц.
  const r = describeMonth('2030-01-15', { now: '2025-06-15' });
  eq(r.status, 'future', 'Future month status');
})();

console.log('\n=== resolveCompletedMonths ===');
(() => {
  const r = resolveCompletedMonths({
    now: '2025-06-15', lookbackMonths: 14, lagDays: 3, sourceMaxDate: '2025-06-13',
  });
  truthy(r.lastComplete && r.lastComplete.key === '2025-05', 'lastComplete = 2025-05');
  truthy(r.prevComplete && r.prevComplete.key === '2025-04', 'prevComplete = 2025-04');
  truthy(r.yoyComplete && r.yoyComplete.key === '2024-05', 'yoyComplete = 2024-05');
  truthy(r.partialMonth && r.partialMonth.key === '2025-06', 'partialMonth = 2025-06');
  eq(r.months.length, 14, 'months length = 14');
})();
(() => {
  // Если source отстаёт настолько, что не покрывает даже последний завершённый
  // месяц → полных месяцев нет.
  const r = resolveCompletedMonths({
    now: '2025-06-15', lookbackMonths: 3, lagDays: 3, sourceMaxDate: '2025-04-15',
  });
  truthy(!r.lastComplete, 'no lastComplete when source behind all months');
  truthy(r.partialMonth, 'partialMonth still present');
})();

console.log('\n=== isPeriodComplete ===');
(() => {
  eq(
    isPeriodComplete({ endDate: '2025-05-31' }, { now: '2025-06-10', lagDays: 3 }),
    { is_complete: true, reason: null },
    'May ended 10 days ago → complete',
  );
  eq(
    isPeriodComplete({ endDate: '2025-06-15' }, { now: '2025-06-15', lagDays: 3 }).is_complete,
    false,
    'Period ending today → not complete',
  );
  eq(
    isPeriodComplete({ endDate: '2025-05-31' }, { now: '2025-06-02', lagDays: 3 }).reason,
    'lag_not_passed',
    'Lag not passed reason',
  );
  eq(
    isPeriodComplete(
      { endDate: '2025-05-31' },
      { now: '2025-06-10', lagDays: 3, sourceMaxDate: '2025-05-20' }
    ).reason,
    'source_behind',
    'Source behind reason',
  );
})();

console.log('\n=== splitSeriesIntoMonths ===');
(() => {
  const series = [
    { date: '2025-04-29', clicks: 10, impressions: 100, ctr: 10, position: 5 },
    { date: '2025-04-30', clicks: 20, impressions: 200, ctr: 10, position: 5 },
    { date: '2025-05-01', clicks: 30, impressions: 300, ctr: 10, position: 4 },
    { date: '2025-05-02', clicks: 40, impressions: 400, ctr: 10, position: 4 },
  ];
  const out = splitSeriesIntoMonths(series, { now: '2025-06-10', lagDays: 3, sourceMaxDate: '2025-05-02' });
  eq(out.length, 2, 'two months');
  eq(out[0].key, '2025-04', 'April first');
  eq(out[0].clicks, 30, 'April clicks summed');
  eq(out[0].impressions, 300, 'April impressions summed');
  eq(out[1].clicks, 70, 'May clicks summed');
  // April fully covered (source >= 2025-04-30 since src=2025-05-02), lag passed → complete.
  truthy(out[0].is_complete, 'April marked complete');
  // May not covered: source=2025-05-02 < 2025-05-31 → partial.
  truthy(out[1].is_partial, 'May marked partial (source behind)');
})();
(() => {
  eq(splitSeriesIntoMonths([]), [], 'empty series → []');
  eq(splitSeriesIntoMonths(null), [], 'null series → []');
})();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
