'use strict';

/**
 * Smoke-tests для модуля «Прогнозатор».
 *  • CSV-парсер: разные форматы заголовков (ISO, "Янв.24", "01.2024"),
 *  • агрегация серии,
 *  • детектор аномалий,
 *  • прогноз (Holt-Winters и fallback),
 *  • модель трафика.
 *
 * Запуск: `node backend/scripts/test-forecaster.js`
 * Без сетевых вызовов (DeepSeek не дёргается).
 */

const assert = require('assert');
const { parseForecasterInput, _parsePeriodFromHeader, _parseNumber } = require('../src/services/forecaster/parser');
const { aggregateMonthlySeries } = require('../src/services/forecaster/series');
const { detectAnomalies } = require('../src/services/forecaster/anomalyDetector');
const { buildForecast, olsTrend } = require('../src/services/forecaster/forecast');
const { estimateTraffic } = require('../src/services/forecaster/trafficModel');
const { classifyJunkPhrases } = require('../src/services/forecaster/junkClassifier');

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`); }
  else      { failed += 1; console.error(`  ✗ ${name}  ${extra}`); }
}

console.log('\n=== parser ===');

ok('parsePeriod ISO',     _parsePeriodFromHeader('2024-01') === '2024-01');
ok('parsePeriod ISO slash', _parsePeriodFromHeader('2024/03') === '2024-03');
ok('parsePeriod MM.YYYY', _parsePeriodFromHeader('01.2024') === '2024-01');
ok('parsePeriod RU дек.24',  _parsePeriodFromHeader('дек.24') === '2024-12');
ok('parsePeriod RU янв 2025', _parsePeriodFromHeader('янв 2025') === '2025-01');
ok('parsePeriod EN Jan-24', _parsePeriodFromHeader('Jan-24') === '2024-01');
ok('parsePeriod garbage→null', _parsePeriodFromHeader('foo bar') === null);

ok('parseNumber RU spaces', _parseNumber('1 234') === 1234);
ok('parseNumber RU comma',  _parseNumber('12,5') === 12.5);
ok('parseNumber empty→0',   _parseNumber('') === 0);
ok('parseNumber NBSP',      _parseNumber('1\u00A0500') === 1500);

// Полный sample-CSV (стиль Wordstat: разделитель ;)
const sampleCsv = [
  'Фраза;Общая частотность;2024-01;2024-02;2024-03;2024-04;2024-05;2024-06;2024-07;2024-08;2024-09;2024-10;2024-11;2024-12;2025-01;2025-02;2025-03;2025-04;2025-05',
  'окна пвх;10000;800;850;900;950;1000;1100;1150;1200;1050;950;850;800;820;860;920;980;1020',
  'купить окна;5000;400;420;440;460;500;550;580;600;530;480;430;400;410;430;460;490;510',
  'окна цены;3000;200;210;220;230;250;280;300;310;270;240;215;200;210;220;235;250;260',
].join('\n');

const parsed = parseForecasterInput(sampleCsv, { filename: 'sample.csv' });
ok('parser rowsCount=3', parsed.rowsCount === 3);
ok('parser monthCols=17', parsed.monthCols.length === 17, `got ${parsed.monthCols.length}`);
ok('parser phraseCol=0', parsed.phraseCol === 0);
ok('parser totalCol=1', parsed.totalCol === 1);
ok('parser warnings empty', parsed.warnings.length === 0, JSON.stringify(parsed.warnings));

console.log('\n=== series ===');
const series = aggregateMonthlySeries(parsed);
ok('series monthly=17', series.monthly.length === 17);
ok('series first=2024-01 sum=1400',
   series.monthly[0].period === '2024-01' && series.monthly[0].demand === 1400,
   JSON.stringify(series.monthly[0]));
ok('series last=2025-05',
   series.monthly[series.monthly.length - 1].period === '2025-05');

console.log('\n=== anomalies ===');
// Создаём ряд с явным провалом в середине
const droppySeries = [];
for (let m = 1; m <= 18; m++) {
  const period = `2024-${String(m > 12 ? m - 12 : m).padStart(2, '0')}`;
  let v = 1000;
  if (m >= 10 && m <= 13) v = 300; // глубокий провал на 4 мес
  droppySeries.push({ period: m > 12 ? `2025-${String(m - 12).padStart(2,'0')}` : `2024-${String(m).padStart(2,'0')}`, demand: v });
}
const anom = detectAnomalies(droppySeries);
ok('anomalies count >= 1', anom.summary.count >= 1, JSON.stringify(anom.summary));
ok('anomalies severity high', anom.summary.max_severity === 'high', JSON.stringify(anom.summary));

console.log('\n=== forecast ===');
// Длинный синтетический сезонный ряд: 36 точек = 3 года
const longSeries = [];
for (let i = 0; i < 36; i++) {
  const trend = 1000 + i * 10;
  const season = Math.sin((i % 12) * Math.PI / 6) * 200; // годовая синусоида
  const period = `${2022 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
  longSeries.push({ period, demand: Math.round(trend + season) });
}
const fc = buildForecast(longSeries);
ok('forecast points=12',  fc.points.length === 12, `got ${fc.points.length}`);
ok('forecast method=HW',  fc.method === 'holt_winters_multiplicative' || fc.method === 'holt_winters_additive', fc.method);
ok('forecast annual_total > 0', fc.annual_total > 0, String(fc.annual_total));
ok('forecast trend direction=up', fc.trend.direction === 'up', JSON.stringify(fc.trend));
ok('forecast CI hi>=value>=lo (sample)',
   fc.points.every((p) => p.hi >= p.value && p.value >= p.lo),
   JSON.stringify(fc.points.slice(0,2)));

// Мультипликативная модель — основная на положительном ряду
ok('forecast HW multiplicative on positive series',
   fc.method === 'holt_winters_multiplicative', fc.method);
ok('forecast params.model=multiplicative',
   fc.params && fc.params.model === 'multiplicative', JSON.stringify(fc.params));

// Нули в истории (запуск нового продукта) → фолбэк на аддитивную модель
const zeroSeries = longSeries.map((p, i) => ({ ...p, demand: i < 3 ? 0 : p.demand }));
const fcZero = buildForecast(zeroSeries);
ok('forecast zeros → additive fallback',
   fcZero.method === 'holt_winters_additive', fcZero.method);
ok('forecast zeros fallback_reason mentions нулевые',
   /нулев/i.test(fcZero.fallback_reason || ''), fcZero.fallback_reason);
ok('forecast zeros points=12 and non-negative',
   fcZero.points.length === 12 && fcZero.points.every((p) => p.value >= 0));

// Прямой вызов мультипликативной модели: нули → null (не определена)
const { holtWintersMultiplicative } = require('../src/services/forecaster/forecast');
ok('HW multiplicative rejects zeros',
   holtWintersMultiplicative([0,1,2,3,4,5,6,7,8,9,10,11,0,1,2,3,4,5,6,7,8,9,10,11], 12, 0.3, 0.1, 0.1) === null);

// Короткий ряд → fallback на trend_with_seasonal_means
const shortSeries = longSeries.slice(0, 10);
const fcShort = buildForecast(shortSeries);
ok('forecast short fallback', fcShort.method === 'trend_with_seasonal_means', fcShort.method);
ok('forecast short points=12', fcShort.points.length === 12);

// Совсем мало точек → insufficient_data
const tinySeries = [{period:'2024-01',demand:100},{period:'2024-02',demand:110},{period:'2024-03',demand:120}];
const fcTiny = buildForecast(tinySeries);
ok('forecast tiny insufficient',
   fcTiny.method === 'insufficient_data' || fcTiny.method === 'trend_with_seasonal_means',
   fcTiny.method);

// OLS
const ols = olsTrend([1, 3, 5, 7, 9]);
ok('OLS perfect slope=2', Math.abs(ols.slope - 2) < 1e-9);
ok('OLS perfect r²=1',    Math.abs(ols.r_squared - 1) < 1e-9);

console.log('\n=== traffic ===');
const traffic = estimateTraffic({
  historicalMonthly: longSeries.slice(-3),
  forecastPoints:    fc.points,
  currentTrafficPerMonth: 500,
});
// Реалистичная модель: реалистично в ТОП-10 попадает больше фраз (~55 %),
// чем в ТОП-3 (~15 %), поэтому суммарный РЕАЛИСТИЧНЫЙ трафик из ТОП-10 БОЛЬШЕ.
// А «потолок» (optimistic) — наоборот: CTR ТОП-3 выше CTR ТОП-10.
ok('traffic top10 realistic > top3 realistic (more phrases qualify)',
   traffic.top10.annual > traffic.top3.annual,
   `top3=${traffic.top3.annual} top10=${traffic.top10.annual}`);
ok('traffic top3 optimistic > top10 optimistic (CTR top3 > CTR top10)',
   traffic.top3.optimistic.annual > traffic.top10.optimistic.annual,
   `top3.opt=${traffic.top3.optimistic.annual} top10.opt=${traffic.top10.optimistic.annual}`);
ok('traffic realism block present', !!traffic.realism && traffic.realism.share_top3 > 0);
ok('traffic implied_ctr_now from user',
   traffic.implied_ctr_now_source === 'user_input');
ok('traffic top3.uplift_x positive',
   traffic.top3.uplift_x > 0);
// Cap: при огромном forecast и крошечном current_traffic — должен сработать cap по top3
const trafficCap = estimateTraffic({
  historicalMonthly: [{period:'2025-01',demand:100},{period:'2025-02',demand:100},{period:'2025-03',demand:100}],
  forecastPoints: Array.from({length:12},(_,i)=>({period:`2026-${String(i+1).padStart(2,'0')}`, value:1000000, lo:900000, hi:1100000})),
  currentTrafficPerMonth: 10, // current annual = 120 → cap top3 = 120 × 8 = 960
});
ok('traffic top3.uplift_capped triggered on absurd forecast vs tiny current',
   trafficCap.top3.uplift_capped === true,
   `capped=${trafficCap.top3.uplift_capped} annual=${trafficCap.top3.annual}`);
ok('traffic top3.uplift_x ≤ max_uplift_x after cap',
   trafficCap.top3.uplift_x <= trafficCap.top3.max_uplift_x + 0.01,
   `uplift_x=${trafficCap.top3.uplift_x} max=${trafficCap.top3.max_uplift_x}`);

// без current traffic → дефолтный CTR
const trafficNoInput = estimateTraffic({
  historicalMonthly: longSeries.slice(-3),
  forecastPoints:    fc.points,
});
ok('traffic default CTR source',
   trafficNoInput.implied_ctr_now_source === 'default_position_20+');
ok('traffic no uplift_x when no input',
   trafficNoInput.top3.uplift_x === null);

console.log('\n=== junk classifier ===');
const monthColsJ = [
  { index: 1, header: '2024-10', period: '2024-10' },
  { index: 2, header: '2024-11', period: '2024-11' },
  { index: 3, header: '2024-12', period: '2024-12' },
  { index: 4, header: '2025-01', period: '2025-01' },
  { index: 5, header: '2025-02', period: '2025-02' },
  { index: 6, header: '2025-03', period: '2025-03' },
];
const junkRows = [
  // too_broad + info_intent (1 слово, частотка > 100k)
  { phrase: 'купить', total: 500000, byPeriod: { '2024-10': 80000, '2024-11': 90000, '2024-12': 100000, '2025-01': 90000, '2025-02': 80000, '2025-03': 60000 } },
  // info_intent
  { phrase: 'окна пвх отзывы', total: 5000, byPeriod: { '2024-10': 800, '2024-11': 900, '2024-12': 1000, '2025-01': 900, '2025-02': 800, '2025-03': 600 } },
  // dead
  { phrase: 'устаревшая фраза 2020', total: 100, byPeriod: { '2024-10': 0, '2024-11': 0, '2024-12': 0, '2025-01': 0, '2025-02': 0, '2025-03': 0 } },
  // foreign_brand
  { phrase: 'купить на ozon.ru', total: 2000, byPeriod: { '2024-10': 300, '2024-11': 300, '2024-12': 300, '2025-01': 300, '2025-02': 300, '2025-03': 200 } },
  // duplicate
  { phrase: 'окна пвх отзывы', total: 5000, byPeriod: { '2024-10': 800, '2024-11': 900, '2024-12': 1000, '2025-01': 900, '2025-02': 800, '2025-03': 600 } },
  // нормальная — НЕ должна попасть в junk
  { phrase: 'окна пвх купить с установкой', total: 1500, byPeriod: { '2024-10': 200, '2024-11': 250, '2024-12': 300, '2025-01': 250, '2025-02': 250, '2025-03': 250 } },
];
const junk = classifyJunkPhrases({ parsedRows: junkRows, monthCols: monthColsJ, targetUrl: 'https://kompy.com' });
ok('junk flagged count == 5', junk.flagged.length === 5,
   `flagged=${junk.flagged.length}`);
ok('junk too_broad detected',
   junk.flagged.some((f) => f.reasons.includes('too_broad')));
ok('junk info_intent detected',
   junk.flagged.some((f) => f.reasons.includes('info_intent')));
ok('junk dead detected',
   junk.flagged.some((f) => f.reasons.includes('dead')));
ok('junk foreign_brand detected for ozon.ru when target=kompy.com',
   junk.flagged.some((f) => f.reasons.includes('foreign_brand')));
ok('junk duplicate detected',
   junk.flagged.some((f) => f.reasons.includes('duplicate')));
ok('junk severity high for too_broad',
   junk.flagged.find((f) => f.reasons.includes('too_broad'))?.severity === 'high');
ok('junk counts.total_rows == 6', junk.counts.total_rows === 6);
ok('junk reason_labels exposed via summary structure (top_examples present)',
   Array.isArray(junk.summary.top_examples) && junk.summary.top_examples.length >= 1);
// targetUrl host detection
ok('junk summary target_host = kompy.com',
   junk.summary.target_host === 'kompy.com');

// без targetUrl → foreign_brand всё равно ловит явный домен в фразе
const junkNoTarget = classifyJunkPhrases({ parsedRows: junkRows, monthCols: monthColsJ });
ok('junk foreign_brand caught even without targetUrl (ozon.ru → flagged)',
   junkNoTarget.flagged.some((f) => f.reasons.includes('foreign_brand')));

console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
