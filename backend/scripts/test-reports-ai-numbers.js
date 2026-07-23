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

console.log('── регрессия «Динамика за период» ─────────────');

// Точная копия _linregress из frontend/src/components/reports/ReportTrendChart.vue —
// эталон, с которым сверяем бэкенд-дайджест.
function refLinregress(data) {
  const pts = [];
  (data || []).forEach((v, i) => {
    if (v == null || !Number.isFinite(v)) return;
    pts.push([i, v]);
  });
  if (pts.length < 2) {
    const only = pts.length === 1 ? pts[0][1] : null;
    return { slope: 0, fitFirst: only, fitLast: only, n: pts.length };
  }
  const n = pts.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
  const denom = n * sxx - sx * sx;
  const slope = denom !== 0 ? (n * sxy - sx * sy) / denom : 0;
  const intercept = (sy - slope * sx) / n;
  return { slope, fitFirst: slope * pts[0][0] + intercept, fitLast: slope * pts[pts.length - 1][0] + intercept, n };
}

test('дайджест GSC-кликов совпадает с регрессией графика (перфектная линия)', () => {
  const series = [{ clicks: 100 }, { clicks: 200 }, { clicks: 300 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 600 } } });
  const ref = refLinregress(series.map((r) => r.clicks));
  assert.strictEqual(d.gsc_clicks_prev, ref.fitFirst);
  assert.strictEqual(d.gsc_clicks_last, ref.fitLast);
  assert.strictEqual(d.gsc_clicks_dir, 'up');
  assert.strictEqual(d.gsc_clicks_delta_pct, 200); // (300-100)/100*100
});

test('дайджест совпадает с регрессией на «шумном» ряду', () => {
  const series = [{ clicks: 120 }, { clicks: 90 }, { clicks: 160 }, { clicks: 210 }];
  const d = _buildMetricsDigest({ gsc: { series, totals: { clicks: 580 } } });
  const ref = refLinregress(series.map((r) => r.clicks));
  const refPct = ref.fitFirst !== 0 ? (ref.fitLast - ref.fitFirst) / Math.abs(ref.fitFirst) * 100 : null;
  assert.strictEqual(d.gsc_clicks_prev, ref.fitFirst);
  assert.strictEqual(d.gsc_clicks_last, ref.fitLast);
  assert.strictEqual(d.gsc_clicks_delta_pct, Math.round(refPct * 10) / 10);
  assert.strictEqual(d.gsc_clicks_dir, ref.slope > 0 ? 'up' : (ref.slope < 0 ? 'down' : 'stable'));
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

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
