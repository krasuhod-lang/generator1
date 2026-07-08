'use strict';

/**
 * Тесты SOV-ядра прогнозатора.
 * Запуск: node backend/scripts/test-forecaster-sov.js
 */

const assert = require('assert');
const { buildSovForecast } = require('../src/services/forecaster/sovForecast');
const { getForecasterConfig } = require('../src/services/forecaster/config');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

function monthly(d0 = 1000) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    out.push({ period: `${y}-${String(m).padStart(2, '0')}`, demand: i === 23 ? d0 : 800 + i * 10 });
  }
  return out;
}
function points(n = 12) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ period: `2026-${String(i + 1).padStart(2, '0')}`, value: 1000 + i * 20 });
  return out;
}

const cfg = getForecasterConfig();

group('sovForecast.buildSovForecast', () => {
  test('lambda < 1 страхуется до 1.5', () => {
    const r = buildSovForecast({ monthly: monthly(), forecastPoints: points(), vCurrent: 100, clusterVolume: 100, mainQueryVolume: 500, cfg });
    assert.strictEqual(r.constants.lambda, 1.5);
  });
  test('C_serp имеет нижний пол 0.1', () => {
    const r = buildSovForecast({ monthly: monthly(), forecastPoints: points(), serpElements: [{ type: 'maps', count: 20 }], clusterVolume: 1000, mainQueryVolume: 100, cfg });
    assert.strictEqual(r.constants.c_serp, 0.1);
  });
  test('CR_final = crBase × commPercent', () => {
    const r = buildSovForecast({ monthly: monthly(), forecastPoints: points(), crBase: 0.02, commPercent: 0.5, clusterVolume: 1000, mainQueryVolume: 100, cfg });
    assert.strictEqual(r.constants.cr_final, 0.01);
  });
  test('SOV_current при D0=0 не падает и равен 0', () => {
    const r = buildSovForecast({ monthly: monthly(0), forecastPoints: points(), vCurrent: 100, clusterVolume: 1000, mainQueryVolume: 100, cfg });
    assert.strictEqual(r.constants.sov_current, 0);
  });
  test('логистическая кривая сходится к целевому SOV', () => {
    const r = buildSovForecast({ monthly: monthly(), forecastPoints: points(24), vCurrent: 0, hMax: 24, clusterVolume: 1000, mainQueryVolume: 1000, cfg });
    const sc = r.scenarios.realistic;
    const d1 = Math.abs(sc.sov[0] - sc.sov_target);
    const d24 = Math.abs(sc.sov[23] - sc.sov_target);
    assert.ok(d24 < d1);
  });
  test('трафик сценариев упорядочен optimistic ≥ realistic ≥ pessimistic', () => {
    const r = buildSovForecast({ monthly: monthly(), forecastPoints: points(), vCurrent: 0, clusterVolume: 1000, mainQueryVolume: 1000, cfg });
    for (let i = 0; i < r.h_max; i++) {
      assert.ok(r.scenarios.optimistic.traffic[i] >= r.scenarios.realistic.traffic[i]);
      assert.ok(r.scenarios.realistic.traffic[i] >= r.scenarios.pessimistic.traffic[i]);
    }
  });
  test('summary берёт realistic и суммирует период', () => {
    const r = buildSovForecast({ monthly: monthly(), forecastPoints: points(), vCurrent: 123, crBase: 0.1, commPercent: 1, clusterVolume: 1000, mainQueryVolume: 1000, cfg });
    assert.strictEqual(r.summary.traffic.at_h, r.scenarios.realistic.traffic[r.h_max - 1]);
    assert.strictEqual(r.summary.traffic.total, r.scenarios.realistic.traffic.reduce((a, b) => a + b, 0));
    assert.strictEqual(r.summary.leads.current, 12.3);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
