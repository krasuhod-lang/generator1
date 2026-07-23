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

console.log(`\n${total - failed}/${total} passed`);
if (failed) process.exit(1);
