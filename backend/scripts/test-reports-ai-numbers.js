'use strict';

/**
 * test-reports-ai-numbers.js — проверяет, что числа в growth_attribution
 * считаются математически (из digest), а не берутся из ответа LLM.
 *
 * Запуск: node backend/scripts/test-reports-ai-numbers.js
 */

const assert = require('assert');
const {
  _applyCanonicalNumbers,
  _classifyMetric,
  _buildMetricsDigest,
} = require('../src/services/reports/aiAnalyst');

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log('  ✓', name); }
  catch (e) { failed += 1; console.log('  ✗', name, '\n     ', e.message); }
}

console.log('── _classifyMetric ────────────────────────────');

test('распознаёт метрики по названию', () => {
  assert.strictEqual(_classifyMetric('Клики из Google'), 'gsc_clicks');
  assert.strictEqual(_classifyMetric('Показы в Google'), 'gsc_impressions');
  assert.strictEqual(_classifyMetric('Клики из Яндекса'), 'ywm_clicks');
  assert.strictEqual(_classifyMetric('Показы в Яндексе'), 'ywm_impressions');
  assert.strictEqual(_classifyMetric('Видимость Keys.so (Яндекс)'), 'keys_so_visibility');
  assert.strictEqual(_classifyMetric('Видимость Keys.so (Google)'), 'keys_so_google_visibility');
  assert.strictEqual(_classifyMetric('ТОП-10 Яндекс'), 'keys_so_top10');
  assert.strictEqual(_classifyMetric('ТОП-10 Google'), 'keys_so_google_top10');
});

test('нераспознанные метрики → null', () => {
  assert.strictEqual(_classifyMetric('Объём выполненных работ'), null);
  assert.strictEqual(_classifyMetric(''), null);
});

console.log('── _applyCanonicalNumbers ─────────────────────');

const digest = {
  gsc_clicks_last: 1500, gsc_clicks_prev: 1200, gsc_clicks_delta_pct: 25,
  keys_so_visibility_delta_pct: 10,
  keys_so_top10_last: 48, keys_so_top10_prev: 30, keys_so_top10_delta_pct: 60,
};

test('перезаписывает выдуманные LLM числа посчитанными', () => {
  const [row] = _applyCanonicalNumbers([
    { metric: 'Клики из Google', trend_direction: 'down', delta_value: '99', delta_pct: '-99%', attribution: 'текст' },
  ], digest);
  assert.strictEqual(row.trend_direction, 'up');
  assert.strictEqual(row.delta_pct, '+25%');
  assert.strictEqual(row.delta_value, '+300 кликов');
  assert.strictEqual(row.attribution, 'текст'); // текст анализа не трогаем
});

test('подставляет процент даже когда LLM оставил поля пустыми', () => {
  const [row] = _applyCanonicalNumbers([
    { metric: 'Видимость Keys.so (Яндекс)', attribution: 'y' },
  ], digest);
  assert.strictEqual(row.trend_direction, 'up');
  assert.strictEqual(row.delta_pct, '+10%');
});

test('очищает числа у нераспознанных метрик (никаких выдуманных цифр)', () => {
  const [row] = _applyCanonicalNumbers([
    { metric: 'Объём выполненных работ', delta_value: '50 задач', delta_pct: '+5%', attribution: 'z' },
  ], digest);
  assert.strictEqual(row.delta_value, '');
  assert.strictEqual(row.delta_pct, '');
  assert.strictEqual(row.trend_direction, '');
  assert.strictEqual(row.attribution, 'z');
});

console.log('── дельта/процент по реальным точкам ──────────');

test('дайджест GSC-кликов: дельта/процент по реальным крайним точкам', () => {
  const series = [{ clicks: 100 }, { clicks: 200 }, { clicks: 300 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 600 } } });
  assert.strictEqual(d.gsc_clicks_prev, 100); // реальная первая точка
  assert.strictEqual(d.gsc_clicks_last, 300); // реальная последняя точка
  assert.strictEqual(d.gsc_clicks_dir, 'up');
  assert.strictEqual(d.gsc_clicks_delta_pct, 200); // (300-100)/100*100
});

test('дельта/процент по реальным точкам на «шумном» ряду (не по регрессии)', () => {
  const series = [{ clicks: 120 }, { clicks: 90 }, { clicks: 160 }, { clicks: 210 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 580 } } });
  // Реальные концы: 120 → 210, а не точки регрессионной прямой.
  assert.strictEqual(d.gsc_clicks_prev, 120);
  assert.strictEqual(d.gsc_clicks_last, 210);
  assert.strictEqual(d.gsc_clicks_delta_pct, 75); // (210-120)/120*100
  assert.strictEqual(d.gsc_clicks_dir, 'up'); // slope > 0
});

test('микро-база: абсурдный процент скрыт, дельта показана', () => {
  // Старт с 1 клика → рост до 500 дал бы +49900% — это скрываем.
  const series = [{ clicks: 1 }, { clicks: 200 }, { clicks: 500 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 701 } } });
  assert.strictEqual(d.gsc_clicks_delta_pct, null); // процент недостоверен → скрыт
  assert.strictEqual(d.gsc_clicks_prev, 1);
  assert.strictEqual(d.gsc_clicks_last, 500);
  assert.strictEqual(d.gsc_clicks_dir, 'up'); // направление всё равно известно
  const [row] = _applyCanonicalNumbers([{ metric: 'Клики из Google', attribution: 't' }], d);
  assert.strictEqual(row.delta_pct, ''); // процент не выводится
  assert.strictEqual(row.trend_direction, 'up');
  assert.strictEqual(row.delta_value, '+499 кликов'); // абсолютная дельта показана
});

test('старт с нуля: процент скрыт (деление на ноль)', () => {
  const series = [{ clicks: 0 }, { clicks: 50 }, { clicks: 120 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 170 } } });
  assert.strictEqual(d.gsc_clicks_delta_pct, null);
  assert.strictEqual(d.gsc_clicks_dir, 'up');
});

test('нисходящий тренд → dir=down, канон-числа форматируются (ru-RU, 1 знак)', () => {
  const series = [{ clicks: 300 }, { clicks: 200 }, { clicks: 100 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 600 } } });
  assert.strictEqual(d.gsc_clicks_dir, 'down');
  const [row] = _applyCanonicalNumbers([{ metric: 'Клики из Google', attribution: 't' }], d);
  assert.strictEqual(row.trend_direction, 'down');
  assert.strictEqual(row.delta_pct, '-66,7%'); // (100-300)/300*100 = -66.67
  assert.strictEqual(row.delta_value, '-200 кликов');
});

test('менее двух точек → дельта скрыта (null)', () => {
  const d = _buildMetricsDigest({ gsc: { series: [{ clicks: 500 }], totals: { clicks: 500 } } });
  assert.strictEqual(d.gsc_clicks_delta_pct, null);
  assert.strictEqual(d.gsc_clicks_prev, null);
  assert.strictEqual(d.gsc_clicks_last, null);
  assert.strictEqual(d.gsc_clicks_dir, null);
});

test('видимость Keys.so: показывается процент, абсолют скрыт', () => {
  const series = [{ visibility: 0.10 }, { visibility: 0.14 }, { visibility: 0.18 }];
  const d = _buildMetricsDigest({ keys_so: { yandex: { series, current: { visibility: 0.18, top10: 12 } } } });
  assert.strictEqual(d.keys_so_visibility_dir, 'up');
  const [row] = _applyCanonicalNumbers([{ metric: 'Видимость Keys.so (Яндекс)', attribution: 'y' }], d);
  assert.strictEqual(row.trend_direction, 'up');
  assert.strictEqual(row.delta_value, ''); // абсолют намеренно скрыт
  assert.ok(row.delta_pct.startsWith('+'), 'процент должен показываться');
});

console.log('── нормализация неполного месяца ──────────────');

const { _normalizePartialSeries } = require('../src/services/reports/dataAggregator');

test('экстраполирует clicks/impressions неполного месяца по normFactor', () => {
  // Апрель (30 дней), собрано 15 дней → normFactor = 2.
  const series = [
    { date: '2026-02-01', clicks: 300, impressions: 3000 },
    { date: '2026-03-01', clicks: 320, impressions: 3200 },
    { date: '2026-04-01', clicks: 150, impressions: 1500 },
  ];
  const meta = {
    monthly_periods: [
      { key: '2026-02', is_partial: false, days: 28 },
      { key: '2026-03', is_partial: false, days: 31 },
      { key: '2026-04', is_partial: true, days: 15 },
    ],
  };
  const out = _normalizePartialSeries(series, meta);
  assert.strictEqual(out[0].clicks, 300); // полные месяцы не трогаем
  assert.strictEqual(out[2].is_normalized, true);
  assert.strictEqual(out[2].norm_factor, 2);
  assert.strictEqual(out[2].clicks, 300); // 150 * 30/15
  assert.strictEqual(out[2].impressions, 3000);
  assert.strictEqual(out[2].actual_clicks, 150); // фактическое сохранено
});

test('мало дней (< порога) → не масштабируем, только метим', () => {
  const series = [
    { date: '2026-03-01', clicks: 300, impressions: 3000 },
    { date: '2026-04-01', clicks: 20, impressions: 200 },
  ];
  const meta = { monthly_periods: [
    { key: '2026-03', is_partial: false, days: 31 },
    { key: '2026-04', is_partial: true, days: 2 },
  ] };
  const out = _normalizePartialSeries(series, meta);
  assert.strictEqual(out[1].is_normalized, false);
  assert.strictEqual(out[1].clicks, 20); // не изменено
  assert.strictEqual(out[1].is_partial_month, true);
});

test('нет неполных месяцев → серия не меняется', () => {
  const series = [{ date: '2026-03-01', clicks: 100 }];
  const meta = { monthly_periods: [{ key: '2026-03', is_partial: false, days: 31 }] };
  assert.strictEqual(_normalizePartialSeries(series, meta), series);
});

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
