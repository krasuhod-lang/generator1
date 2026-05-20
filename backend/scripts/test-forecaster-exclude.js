'use strict';

/**
 * Smoke-test для исключения «шлак-запросов» из расчёта спроса.
 *
 *   • Однословный ВЧ-запрос («купить», total=500k) должен помечаться
 *     exclude_from_forecast: true и вычитаться из monthly_series.total.
 *   • Datасет с/без этой фразы → totalDemand отличается ровно на её
 *     суммарный вклад.
 *   • Backward-compat: вызов aggregateMonthlySeries(parsed) без второго
 *     аргумента работает как раньше.
 *
 * Запуск: `node backend/scripts/test-forecaster-exclude.js`
 * Без сетевых вызовов.
 */

const assert = require('assert');
const { aggregateMonthlySeries } = require('../src/services/forecaster/series');
const { classifyJunkPhrases }    = require('../src/services/forecaster/junkClassifier');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

const monthCols = [
  { index: 1, header: '2024-10', period: '2024-10' },
  { index: 2, header: '2024-11', period: '2024-11' },
  { index: 3, header: '2024-12', period: '2024-12' },
  { index: 4, header: '2025-01', period: '2025-01' },
  { index: 5, header: '2025-02', period: '2025-02' },
  { index: 6, header: '2025-03', period: '2025-03' },
];

const rows = [
  // однословник с гигантской частоткой — должен быть исключён
  { phrase: 'купить', total: 500000,
    byPeriod: { '2024-10': 80000, '2024-11': 90000, '2024-12': 100000,
                '2025-01': 90000, '2025-02': 80000, '2025-03': 60000 } },
  // нормальная коммерческая фраза
  { phrase: 'окна пвх купить с установкой', total: 1500,
    byPeriod: { '2024-10': 200, '2024-11': 250, '2024-12': 300,
                '2025-01': 250, '2025-02': 250, '2025-03': 250 } },
  // мёртвый запрос — должен быть исключён
  { phrase: 'устаревшая фраза 2020', total: 100,
    byPeriod: { '2024-10': 0, '2024-11': 0, '2024-12': 0,
                '2025-01': 0, '2025-02': 0, '2025-03': 0 } },
];

const parsed = { rows, monthCols, rowsCount: rows.length };

console.log('\n=== junk + exclude_from_forecast ===');
const junk = classifyJunkPhrases({ parsedRows: rows, monthCols, targetUrl: 'https://kompy.com' });
const tooBroad = junk.flagged.find((f) => f.reasons.includes('too_broad'));
ok('too_broad помечен exclude_from_forecast=true',
   tooBroad && tooBroad.exclude_from_forecast === true);
const dead = junk.flagged.find((f) => f.reasons.includes('dead'));
ok('dead помечен exclude_from_forecast=true',
   dead && dead.exclude_from_forecast === true);
ok('summary.excluded_count == 2', junk.summary.excluded_count === 2,
   `got=${junk.summary.excluded_count}`);
ok('summary.excluded_total_demand == 500100',
   junk.summary.excluded_total_demand === 500100,
   `got=${junk.summary.excluded_total_demand}`);
ok('counts.excluded_count == 2', junk.counts.excluded_count === 2);

console.log('\n=== aggregateMonthlySeries без excludePhrases (BC) ===');
const bc = aggregateMonthlySeries(parsed);
const expectedBC = rows.reduce((a, r) =>
  a + Object.values(r.byPeriod).reduce((x, y) => x + y, 0), 0);
ok('BC: totalDemand содержит все фразы', bc.totalDemand === expectedBC,
   `expected=${expectedBC} got=${bc.totalDemand}`);
ok('BC: excludedSummary не выставлен',
   bc.excludedSummary === undefined);
ok('BC: phrasesCount = rows.length', bc.phrasesCount === rows.length);

console.log('\n=== aggregateMonthlySeries c excludePhrases ===');
const excludeSet = new Set(
  junk.flagged.filter((f) => f.exclude_from_forecast)
    .map((f) => f.phrase.toLowerCase()),
);
const filtered = aggregateMonthlySeries(parsed, { excludePhrases: excludeSet });
const expectedFiltered = Object.values(rows[1].byPeriod).reduce((a, b) => a + b, 0);
ok('totalDemand уменьшился ровно на сумму исключённых',
   filtered.totalDemand === expectedFiltered,
   `expected=${expectedFiltered} got=${filtered.totalDemand}`);
ok('totalDemand < BC totalDemand',
   filtered.totalDemand < bc.totalDemand);
ok('excludedSummary.phrases == 2',
   filtered.excludedSummary?.phrases === 2,
   `got=${filtered.excludedSummary?.phrases}`);
ok('excludedSummary.total_demand содержит «купить»',
   filtered.excludedSummary?.total_demand > 0 &&
   filtered.excludedSummary.sample_phrases.includes('купить'));
ok('phrasesCount уменьшен на 2',
   filtered.phrasesCount === rows.length - 2,
   `got=${filtered.phrasesCount}`);

console.log('\n=== пустой Set → BC ===');
const emptySet = aggregateMonthlySeries(parsed, { excludePhrases: new Set() });
ok('пустой Set → totalDemand как в BC',
   emptySet.totalDemand === bc.totalDemand);
ok('пустой Set → excludedSummary не выставлен',
   emptySet.excludedSummary === undefined);

console.log('\n=== Array excludePhrases (не Set) ===');
const arrInput = aggregateMonthlySeries(parsed, { excludePhrases: ['купить', 'УСТАРЕВШАЯ ФРАЗА 2020'] });
ok('Array excludePhrases работает (нормализуем регистр)',
   arrInput.totalDemand === expectedFiltered,
   `got=${arrInput.totalDemand}`);

console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
