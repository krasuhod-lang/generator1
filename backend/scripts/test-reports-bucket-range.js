/**
 * Unit-тесты для _bucketRange / _alignSeriesToRange (ТЗ #1).
 *
 * Запуск: node backend/scripts/test-reports-bucket-range.js
 */
const assert = require('assert');
const { _bucketRange, _alignSeriesToRange } = require('../src/services/reports/dataAggregator');

let passed = 0;
let failed = 0;
function it(name, fn) {
  try { fn(); console.log('  ok  -', name); passed += 1; }
  catch (err) { console.log('  FAIL -', name, '\n        ', err.message); failed += 1; }
}

console.log('# _bucketRange');
it('месячная гранулярность: 3 месяца → 3 бакета (первые числа)', () => {
  const r = _bucketRange('2025-04-10', '2025-06-20', 'month');
  assert.deepStrictEqual(r.keys, ['2025-04-01', '2025-05-01', '2025-06-01']);
  assert.strictEqual(r.count, 3);
});
it('месячная гранулярность: 12 месяцев', () => {
  const r = _bucketRange('2024-07-01', '2025-06-30', 'month');
  assert.strictEqual(r.count, 12);
  assert.strictEqual(r.keys[0], '2024-07-01');
  assert.strictEqual(r.keys[11], '2025-06-01');
});
it('недельная гранулярность: понедельники', () => {
  const r = _bucketRange('2025-04-01', '2025-04-21', 'week');
  // должно быть несколько ISO-понедельников в диапазоне
  assert.ok(r.count >= 3 && r.count <= 4, `count=${r.count}`);
  for (const k of r.keys) {
    const d = new Date(`${k}T00:00:00Z`);
    assert.strictEqual(d.getUTCDay(), 1, `${k} должен быть понедельником`);
  }
});
it('дневная гранулярность: 5 дней', () => {
  const r = _bucketRange('2025-04-01', '2025-04-05', 'day');
  assert.deepStrictEqual(r.keys, ['2025-04-01', '2025-04-02', '2025-04-03', '2025-04-04', '2025-04-05']);
});
it('пустые входы → пустой результат', () => {
  assert.deepStrictEqual(_bucketRange('', '', 'month'), { keys: [], count: 0 });
});
it('защитный потолок 1024 бакета', () => {
  const r = _bucketRange('2000-01-01', '2099-12-31', 'day');
  assert.ok(r.count <= 1024);
});

console.log('# _alignSeriesToRange');
it('новый GSC-проект: 3 точки из 6 ожидаемых → 6 строк с null-дырками', () => {
  const sparse = [
    { date: '2025-04-01', clicks: 10, impressions: 100, ctr: 0.1, position: 5 },
    { date: '2025-05-01', clicks: 20, impressions: 200, ctr: 0.1, position: 4 },
    { date: '2025-06-01', clicks: 30, impressions: 300, ctr: 0.1, position: 3 },
  ];
  const { series, range } = _alignSeriesToRange(sparse, '2025-01-01', '2025-06-30', 'month');
  assert.strictEqual(series.length, 6);
  assert.strictEqual(range.expected_buckets, 6);
  assert.strictEqual(range.actual_buckets, 3);
  assert.strictEqual(range.actual_from, '2025-04-01');
  assert.strictEqual(range.actual_to, '2025-06-01');
  assert.strictEqual(range.has_gaps, true);
  // первые 3 бакета — null-фillers
  assert.strictEqual(series[0].clicks, null);
  assert.strictEqual(series[2].clicks, null);
  // последние 3 — реальные данные
  assert.strictEqual(series[3].clicks, 10);
  assert.strictEqual(series[5].clicks, 30);
});
it('полный диапазон: has_gaps=false, длина = expected', () => {
  const full = [
    { date: '2025-04-01', clicks: 1, impressions: 10, ctr: 0.1, position: 5 },
    { date: '2025-05-01', clicks: 2, impressions: 20, ctr: 0.1, position: 5 },
    { date: '2025-06-01', clicks: 3, impressions: 30, ctr: 0.1, position: 5 },
  ];
  const { series, range } = _alignSeriesToRange(full, '2025-04-01', '2025-06-30', 'month');
  assert.strictEqual(series.length, 3);
  assert.strictEqual(range.expected_buckets, 3);
  assert.strictEqual(range.actual_buckets, 3);
  assert.strictEqual(range.has_gaps, false);
});
it('пустая серия → все null-fillers', () => {
  const { series, range } = _alignSeriesToRange([], '2025-04-01', '2025-06-30', 'month');
  assert.strictEqual(series.length, 3);
  assert.strictEqual(range.actual_buckets, 0);
  assert.strictEqual(range.actual_from, null);
  assert.strictEqual(range.has_gaps, true);
  for (const r of series) assert.strictEqual(r.clicks, null);
});
it('custom valueKeys для Keys.so (visibility/keywords_top10)', () => {
  const sparse = [
    { date: '2025-04-01', visibility: 50, keywords_top10: 12 },
  ];
  const { series } = _alignSeriesToRange(sparse, '2025-03-01', '2025-05-31', 'month',
    ['visibility', 'keywords_top10']);
  assert.strictEqual(series.length, 3);
  assert.strictEqual(series[0].visibility, null);
  assert.strictEqual(series[0].keywords_top10, null);
  assert.strictEqual(series[1].visibility, 50);
  assert.strictEqual(series[1].keywords_top10, 12);
});

console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
