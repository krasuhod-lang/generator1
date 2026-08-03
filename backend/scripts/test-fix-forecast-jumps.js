'use strict';

/**
 * Тесты утилиты пересчёта старых отчётов прогнозатора (fix-forecast-jumps.js).
 * Проверяют чистую часть (без БД): восстановление входных данных из
 * сохранённого JSONB и отсутствие скачка трафика в M1 после пересчёта.
 *
 * Запуск: node backend/scripts/test-fix-forecast-jumps.js
 */

const assert = require('assert');
const { rebuildTaskForecast, rebuildLeadsSummary } = require('./fix-forecast-jumps');
const { getForecasterConfig } = require('../src/services/forecaster/config');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

const cfg = getForecasterConfig();

function monthly(base = 1000000) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    out.push({ period: `${y}-${String(m).padStart(2, '0')}`, demand: base, phrases_count: 100 });
  }
  return out;
}

// Задача «как в БД»: старый unified со скачком в M1 (4500 при старте 100).
function fakeTask(over = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    options: { current_traffic_per_month: 100, h_max: 12 },
    monthly_series: { monthly: monthly() },
    forecast: { points: [] },
    unified_forecast: {
      verdict: 'ok',
      params: { c_serp: 1, comm_percent: 1 },
      forecast: [{ period: '2026-01', t: 1, value: 4500 }],
    },
    sov_forecast: { constants: { lambda: 1.5, c_serp: 1 } },
    leads_summary: { conversion_rate: 0.015, unified_annual: 999999 },
    ...over,
  };
}

group('rebuildTaskForecast — пересчёт сохранённой задачи', () => {
  test('скачок M1 убран: трафик стартует от текущего значения', () => {
    const r = rebuildTaskForecast(fakeTask(), cfg);
    assert.strictEqual(r.unified.verdict, 'ok');
    const m1 = r.unified.forecast[0].value;
    const cap1 = Math.max(100 * (1 + cfg.unified.growthCapPerMonth), 100 + cfg.unified.absGrowthPerMonth);
    assert.ok(m1 <= cap1 + 1, `M1=${m1} > cap ${cap1}`);
    assert.ok(m1 >= 100, `M1=${m1} не ниже старта`);
  });

  test('sov синхронизирован с новым unified (realistic = unified.value)', () => {
    const r = rebuildTaskForecast(fakeTask(), cfg);
    assert.strictEqual(r.sov.scenarios.realistic.source, 'unified');
    assert.deepStrictEqual(
      r.sov.scenarios.realistic.traffic,
      r.unified.forecast.map((p) => p.value),
    );
  });

  test('короткий ряд → skip без падения', () => {
    const task = fakeTask({ monthly_series: { monthly: monthly().slice(0, 2) } });
    const r = rebuildTaskForecast(task, cfg);
    assert.ok(r.skip, 'ожидали skip');
  });

  test('C_serp восстанавливается из сохранённого результата (без Арсенкина)', () => {
    const task = fakeTask({
      unified_forecast: { verdict: 'ok', params: { c_serp: 0.75, comm_percent: 1 }, forecast: [] },
    });
    const r = rebuildTaskForecast(task, cfg);
    assert.ok(Math.abs(r.unified.params.c_serp - 0.75) < 1e-4, `c_serp=${r.unified.params.c_serp}`);
  });

  test('serp_elements из options имеют приоритет над сохранённым C_serp', () => {
    const task = fakeTask({
      options: { current_traffic_per_month: 100, h_max: 12, serp_elements: [{ type: 'maps', count: 2 }] },
    });
    const r = rebuildTaskForecast(task, cfg);
    // C_serp = 1 − 0.15·2 = 0.70
    assert.ok(Math.abs(r.unified.params.c_serp - 0.70) < 1e-4, `c_serp=${r.unified.params.c_serp}`);
  });

  test('λ восстанавливается из sov_forecast.constants', () => {
    const task = fakeTask({ sov_forecast: { constants: { lambda: 2.5, c_serp: 1 } } });
    const r = rebuildTaskForecast(task, cfg);
    assert.strictEqual(r.sov.constants.lambda, 2.5);
  });

  test('comm_percent берётся из сохранённых params, если его нет в options', () => {
    const task = fakeTask({
      unified_forecast: { verdict: 'ok', params: { c_serp: 1, comm_percent: 0.5 }, forecast: [] },
    });
    const r = rebuildTaskForecast(task, cfg);
    assert.ok(Math.abs(r.unified.params.comm_percent - 0.5) < 1e-6);
    // CR_final = CR_base × comm
    assert.ok(Math.abs(r.unified.params.cr_final - cfg.leads.defaultConversionRate * 0.5) < 1e-5);
  });

  test('горизонт берётся из options.h_max с клэмпом по config', () => {
    const task = fakeTask({ options: { current_traffic_per_month: 100, h_max: 99 } });
    const r = rebuildTaskForecast(task, cfg);
    assert.strictEqual(r.unified.horizon, cfg.sov.hMaxLimit);
    assert.strictEqual(r.sov.h_max, cfg.sov.hMaxLimit);
  });
});

group('rebuildLeadsSummary — шапка результата', () => {
  test('unified_* обновляются, прочие поля сохраняются', () => {
    const r = rebuildTaskForecast(fakeTask(), cfg);
    const ls = rebuildLeadsSummary({ conversion_rate: 0.015, unified_annual: 999999 }, r.unified);
    assert.strictEqual(ls.conversion_rate, 0.015);
    assert.strictEqual(ls.unified_annual, r.unified.summary.annual.value);
    assert.notStrictEqual(ls.unified_annual, 999999);
  });

  test('нет leads_summary → null (колонка не перетирается)', () => {
    assert.strictEqual(rebuildLeadsSummary(null, {}), null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
