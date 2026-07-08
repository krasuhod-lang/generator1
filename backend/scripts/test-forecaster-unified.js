'use strict';

/**
 * Тесты единой («перепрошитой») модели прогноза трафика.
 * Запуск: node backend/scripts/test-forecaster-unified.js
 */

const assert = require('assert');
const { buildUnifiedForecast, _seasonalFactors } = require('../src/services/forecaster/unifiedForecast');
const { getForecasterConfig } = require('../src/services/forecaster/config');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

const cfg = getForecasterConfig();

// Ровный ряд без сезонности, 24 месяца, спрос ≈ 1000/мес.
function flatMonthly(base = 1000) {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    out.push({ period: `${y}-${String(m).padStart(2, '0')}`, demand: base });
  }
  return out;
}

// Ряд с летней просадкой (июнь/июль/авг ниже).
function seasonalMonthly() {
  const out = [];
  for (let i = 0; i < 24; i++) {
    const y = 2024 + Math.floor(i / 12);
    const m = (i % 12) + 1;
    const summer = (m >= 6 && m <= 8) ? 0.5 : 1.0;
    out.push({ period: `${y}-${String(m).padStart(2, '0')}`, demand: Math.round(1000 * summer) });
  }
  return out;
}

group('buildUnifiedForecast — базовая структура', () => {
  test('вердикт ok и заполнены params/retro/forecast', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: { h_max: 12 }, currentTrafficPerMonth: 100, cfg });
    assert.strictEqual(r.verdict, 'ok');
    assert.ok(r.params && Array.isArray(r.params.seasonal) && r.params.seasonal.length === 12);
    assert.strictEqual(r.retro.length, 24);
    assert.strictEqual(r.forecast.length, 12);
    assert.ok(r.summary.annual.value > 0);
  });

  test('слишком короткий ряд → insufficient_data', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly().slice(0, 2), options: {}, cfg });
    assert.strictEqual(r.verdict, 'insufficient_data');
  });

  test('дефолты параметров подтягиваются из config.unified', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: {}, currentTrafficPerMonth: 100, cfg });
    assert.strictEqual(r.params.c_yield, cfg.unified.cYieldDefault);
    assert.strictEqual(r.params.target_ctr, cfg.unified.targetCtrDefault);
    assert.strictEqual(r.params.k, cfg.unified.kDefault);
    assert.strictEqual(r.params.t0, cfg.unified.t0Default);
    assert.strictEqual(r.params.delta, cfg.unified.deltaDefault);
  });
});

group('Блок 3 — SOV', () => {
  test('SOV_start = текущий трафик / текущий спрос', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000), options: {}, currentTrafficPerMonth: 50, cfg });
    // dNow = 1000, sov_start = 50/1000 = 0.05
    assert.ok(Math.abs(r.params.sov_start - 0.05) < 1e-6);
  });

  test('новый сайт (нет трафика) → SOV_start = 0, ретро-трафик = 0', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000), options: {}, currentTrafficPerMonth: 0, cfg });
    assert.strictEqual(r.params.sov_start, 0);
    assert.ok(r.retro.every((p) => p.traffic === 0));
  });

  test('SOV_max = target_ctr × C_serp; без serp-фичей C_serp=1', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: { target_ctr: 0.03 }, serpElements: [], cfg });
    assert.strictEqual(r.params.c_serp, 1);
    assert.ok(Math.abs(r.params.sov_max - 0.03) < 1e-6);
  });

  test('serp-фичи снижают C_serp и потолок SOV_max', () => {
    const r = buildUnifiedForecast({
      monthly: flatMonthly(), options: { target_ctr: 0.03 },
      serpElements: [{ type: 'maps', count: 1 }, { type: 'market', count: 1 }], cfg,
    });
    assert.ok(r.params.c_serp < 1);
    assert.ok(r.params.sov_max < 0.03);
  });
});

group('Логистика + монотонность захвата', () => {
  test('capture растёт со временем к SOV_max (новый сайт)', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: { h_max: 12 }, currentTrafficPerMonth: 0, cfg });
    const caps = r.forecast.map((p) => p.capture);
    for (let i = 1; i < caps.length; i++) assert.ok(caps[i] >= caps[i - 1] - 1e-9, `capture должен расти: ${caps[i-1]} → ${caps[i]}`);
    // не превышает потолок
    assert.ok(caps[caps.length - 1] <= r.params.sov_max + 1e-9);
  });

  test('переоценённый сайт (высокий SOV_start) → защита от падения: доля не снижается', () => {
    // sov_start = 500/1000 = 0.5 > target_ctr·c_serp = 0.03,
    // но SOV_max = max(0.03, 0.5·(1+G)) → доля рынка растёт, а не рушится.
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000), options: { target_ctr: 0.03 }, currentTrafficPerMonth: 500, cfg });
    assert.ok(r.params.sov_max >= r.params.sov_start, `sov_max ${r.params.sov_max} ≥ sov_start ${r.params.sov_start}`);
    const v = r.forecast.map((p) => p.capture);
    for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1] - 1e-9, `capture не должен падать: ${v[i-1]} → ${v[i]}`);
    assert.ok(v.every((c) => c >= r.params.sov_start - 1e-9), 'capture никогда не ниже sov_start');
  });

  test('SOV_max = max(target_ctr·C_serp, sov_start·(1+G))', () => {
    const G = cfg.unified.minGrowthDefault;
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000), options: { target_ctr: 0.03 }, currentTrafficPerMonth: 500, cfg });
    assert.ok(Math.abs(r.params.sov_max - Math.min(1, 0.5 * (1 + G))) < 1e-6);
  });

  test('capture монотонен и не ниже старта при расширении семантики (CTR-размытие)', () => {
    const r = buildUnifiedForecast({
      monthly: flatMonthly(1000), options: { h_max: 24, semantic_expansion_rate: 0.1 },
      currentTrafficPerMonth: 100, cfg,
    });
    const caps = r.forecast.map((p) => p.capture);
    for (let i = 1; i < caps.length; i++) assert.ok(caps[i] >= caps[i - 1] - 1e-9);
    assert.ok(caps.every((c) => c >= r.params.sov_start - 1e-9));
  });
});

group('Плавномерный рост трафика (десезонализированное ядро)', () => {
  // Убывающий рынок: спрос падает на 10/мес — раньше трафик падал вслед,
  // теперь десезонализированное ядро (core) монотонно не убывает,
  // просадки допускаются только сезонные.
  function decliningMonthly() {
    const out = [];
    for (let i = 0; i < 24; i++) {
      const y = 2024 + Math.floor(i / 12);
      const m = (i % 12) + 1;
      out.push({ period: `${y}-${String(m).padStart(2, '0')}`, demand: 2000 - i * 10 });
    }
    return out;
  }

  test('core (без сезонности) монотонно растёт даже на падающем рынке', () => {
    const r = buildUnifiedForecast({ monthly: decliningMonthly(), options: { h_max: 12 }, currentTrafficPerMonth: 200, cfg });
    const cores = r.forecast.map((p) => p.core);
    for (let i = 1; i < cores.length; i++) {
      assert.ok(cores[i] >= cores[i - 1], `ядро не должно падать: ${cores[i-1]} → ${cores[i]}`);
    }
  });

  test('value ≥ core × сезонность: сезонные просадки допустимы, YoY-floor не даёт упасть ниже прошлого года', () => {
    const r = buildUnifiedForecast({ monthly: seasonalMonthly(), options: { h_max: 12 }, currentTrafficPerMonth: 200, cfg });
    for (const p of r.forecast) {
      // Формула ядра: value ≥ core·s (YoY-floor может поднять выше, но не опустить).
      assert.ok(p.value + 2 >= Math.round(p.core * p.seasonal),
        `value≥core·s: ${p.value} vs ${p.core}·${p.seasonal}`);
    }
  });

  test('YoY-инвариант: трафик каждого месяца ≥ трафика того же месяца прошлого года', () => {
    // Год 2 vs год 1: capture ≥ sov_start, поэтому value(t+12) ≥ value(t).
    const r = buildUnifiedForecast({ monthly: seasonalMonthly(), options: { h_max: 24 }, currentTrafficPerMonth: 200, cfg });
    // Соединяем ретро+прогноз в единый ряд по месяцу-абсолюту.
    const byIdx = new Map();
    for (const p of r.retro) {
      const mm = p.period.match(/^(\d{4})-(\d{2})$/);
      if (mm) byIdx.set(Number(mm[1]) * 12 + Number(mm[2]) - 1, p.traffic);
    }
    for (const p of r.forecast) {
      const mm = p.period.match(/^(\d{4})-(\d{2})$/);
      if (mm) byIdx.set(Number(mm[1]) * 12 + Number(mm[2]) - 1, p.value);
    }
    for (const p of r.forecast) {
      const mm = p.period.match(/^(\d{4})-(\d{2})$/);
      if (!mm) continue;
      const idx = Number(mm[1]) * 12 + Number(mm[2]) - 1;
      const prev = byIdx.get(idx - 12);
      if (prev == null) continue;
      assert.ok(p.value + 1 >= prev, `${p.period}: ${p.value} < YoY ${prev}`);
    }
  });

  test('ровный ряд без сезонности → трафик строго не убывает', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000), options: { h_max: 12 }, currentTrafficPerMonth: 100, cfg });
    const vals = r.forecast.map((p) => p.value);
    for (let i = 1; i < vals.length; i++) assert.ok(vals[i] >= vals[i - 1], `${vals[i-1]} → ${vals[i]}`);
  });
});

group('Блок 2 — расширение семантики (r)', () => {
  test('r=0.02 повышает потенциал спроса относительно r=0', () => {
    const base = buildUnifiedForecast({ monthly: flatMonthly(), options: { h_max: 12, semantic_expansion_rate: 0 }, currentTrafficPerMonth: 0, cfg });
    const grown = buildUnifiedForecast({ monthly: flatMonthly(), options: { h_max: 12, semantic_expansion_rate: 0.02 }, currentTrafficPerMonth: 0, cfg });
    const b12 = base.forecast[11].demand_potential;
    const g12 = grown.forecast[11].demand_potential;
    // (1 + 0.02*12) = 1.24 → ~+24 %
    assert.ok(g12 > b12);
    assert.ok(Math.abs(g12 / b12 - 1.24) < 0.02, `ожидали ~1.24, получили ${(g12 / b12).toFixed(3)}`);
  });
});

group('Коридор погрешности δ·√t', () => {
  test('t=1 → ±δ; upper/lower симметричны на первом месяце', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000000), options: { h_max: 12, uncertainty_delta: 0.05 }, currentTrafficPerMonth: 200000, cfg });
    const p1 = r.forecast[0];
    if (p1.value > 0) {
      assert.ok(Math.abs(p1.upper / p1.value - 1.05) < 0.001);
      assert.ok(Math.abs(1 - p1.lower / p1.value - 0.05) < 0.001);
    }
  });

  test('t=12 → коридор ≈ ±δ·√12 ≈ ±17 %', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(1000000), options: { h_max: 12, uncertainty_delta: 0.05 }, currentTrafficPerMonth: 200000, cfg });
    const p12 = r.forecast[11];
    if (p12.value > 0) {
      const spread = p12.upper / p12.value - 1;
      assert.ok(Math.abs(spread - 0.05 * Math.sqrt(12)) < 0.01, `ожидали ~0.173, получили ${spread.toFixed(3)}`);
    }
  });

  test('нижняя граница никогда не уходит ниже 0', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: { h_max: 24, uncertainty_delta: 0.20 }, currentTrafficPerMonth: 100, cfg });
    assert.ok(r.forecast.every((p) => p.lower >= 0));
  });
});

group('Сезонность (мультипликативная)', () => {
  test('множители нормированы к среднему ~1 и в пределах [min,max]', () => {
    const r = buildUnifiedForecast({ monthly: seasonalMonthly(), options: {}, currentTrafficPerMonth: 100, cfg });
    const s = r.params.seasonal;
    const mean = s.reduce((a, b) => a + b, 0) / 12;
    assert.ok(Math.abs(mean - 1) < 0.25, `среднее сезонности ~1, получили ${mean.toFixed(3)}`);
    assert.ok(s.every((v) => v >= cfg.unified.seasonalMin - 1e-9 && v <= cfg.unified.seasonalMax + 1e-9));
    // летние месяцы (июнь=index5 .. авг=index7) ниже среднего
    assert.ok(s[6] < 1, `июль должен быть ниже среднего, получили ${s[6]}`);
  });
});

group('explain — пояснения для бизнеса', () => {
  test('есть summary, factors[] и строка по горизонту', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: {}, currentTrafficPerMonth: 100, cfg });
    assert.ok(typeof r.explain.summary === 'string' && r.explain.summary.length > 10);
    assert.ok(Array.isArray(r.explain.factors) && r.explain.factors.length >= 8);
    assert.ok(r.explain.factors.every((f) => f.label && f.plain));
    assert.ok(typeof r.explain.horizon_line === 'string');
  });
});

group('start_month — якорь месяца старта работ', () => {
  test('без start_month: прогноз начинается со следующего месяца после истории', () => {
    const r = buildUnifiedForecast({ monthly: flatMonthly(), options: { h_max: 3 }, currentTrafficPerMonth: 100, cfg });
    // История заканчивается 2025-12 → прогноз начинается 2026-01.
    assert.strictEqual(r.forecast[0].period, '2026-01');
    assert.strictEqual(r.start_period, '2026-01');
  });

  test('start_month = 2026-06 → прогноз t=1 приходится на 2026-06', () => {
    const r = buildUnifiedForecast({
      monthly: flatMonthly(),
      options: { h_max: 6, start_month: '2026-06' },
      currentTrafficPerMonth: 100, cfg,
    });
    assert.strictEqual(r.forecast[0].period, '2026-06');
    assert.strictEqual(r.forecast[5].period, '2026-11');
    assert.strictEqual(r.start_period, '2026-06');
  });
});

group('YoY-множители: спрос × позиции — прозрачность', () => {
  test('capture_growth и demand_yoy заполнены при наличии истории', () => {
    const r = buildUnifiedForecast({
      monthly: flatMonthly(1000),
      options: { h_max: 12, start_month: '2026-01' },
      currentTrafficPerMonth: 100, cfg,
    });
    // 2026-01 ↔ 2025-01: demand_yoy сравнивает demand_potential к retro-demand.
    assert.ok(r.forecast[0].capture_growth != null && r.forecast[0].capture_growth >= 1);
    assert.ok(r.forecast[0].demand_yoy != null);
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
