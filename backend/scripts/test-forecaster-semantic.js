'use strict';

/**
 * Тесты графа охвата семантики (buildSemanticDistribution) и
 * нормализации AI-отчёта (forecastReport helpers).
 * Запуск: node backend/scripts/test-forecaster-semantic.js
 */

const assert = require('assert');
const { buildSemanticDistribution } = require('../src/services/forecaster/trafficModel');
const { _extractJson, _normalizeReport, _buildContext } = require('../src/services/forecaster/forecastReport');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

function keywords(n = 100, demandEach = 100) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ phrase: `фраза ${i}`, total: demandEach });
  return out;
}

function unifiedStub(h = 12) {
  const fc = [];
  for (let t = 1; t <= h; t++) {
    fc.push({
      period: `2026-${String(t).padStart(2, '0')}`,
      value: 1000 + t * 500,
      upper: 1300 + t * 700,
      lower: 800 + t * 400,
      capture: 0.02 + (0.10 - 0.02) * (t / h),
    });
  }
  return {
    verdict: 'ok',
    horizon: h,
    forecast: fc,
    params: { sov_start: 0.02, sov_max: 0.10 },
  };
}

function trafficEstimateStub() {
  return {
    realism: { share_top3: 0.15, share_top5: 0.28, share_top10: 0.55 },
    top10: {
      monthly: Array.from({ length: 12 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, '0')}`, traffic: 500 + i * 100 })),
      optimistic: { monthly: Array.from({ length: 12 }, (_, i) => ({ period: `2026-${String(i + 1).padStart(2, '0')}`, traffic: 900 + i * 150 })) },
    },
  };
}

group('buildSemanticDistribution', () => {
  test('возвращает ряд по каждому месяцу unified-прогноза', () => {
    const dist = buildSemanticDistribution(keywords(), {
      unifiedForecast: unifiedStub(),
      trafficEstimate: trafficEstimateStub(),
      keyssoAggregate: null,
    });
    assert.ok(Array.isArray(dist));
    assert.strictEqual(dist.length, 12);
    assert.strictEqual(dist[0].month, 'M1');
    assert.strictEqual(dist[11].month, 'M12');
    assert.ok(/^(Январь|Февраль|Март|Апрель|Май|Июнь|Июль|Август|Сентябрь|Октябрь|Ноябрь|Декабрь) \d{4}$/.test(dist[0].label));
  });

  test('корзины эксклюзивны и в сумме дают всё ядро (count и volume)', () => {
    const kw = keywords(137, 42);
    const dist = buildSemanticDistribution(kw, {
      unifiedForecast: unifiedStub(),
      trafficEstimate: trafficEstimateStub(),
    });
    for (const m of dist) {
      const d = m.distribution;
      const cnt = d.top3.count + d.top10.count + d.top20.count + d.out.count;
      const vol = d.top3.volume + d.top10.volume + d.top20.volume + d.out.volume;
      assert.strictEqual(cnt, 137, `count в ${m.month}`);
      assert.strictEqual(vol, 137 * 42, `volume в ${m.month}`);
      assert.ok(d.top3.count >= 0 && d.top10.count >= 0 && d.top20.count >= 0 && d.out.count >= 0);
    }
  });

  test('охват топов растёт по месяцам (кумулятивные доли монотонны)', () => {
    const dist = buildSemanticDistribution(keywords(), {
      unifiedForecast: unifiedStub(),
      trafficEstimate: trafficEstimateStub(),
    });
    for (let i = 1; i < dist.length; i++) {
      assert.ok(dist[i].coverage.top3 >= dist[i - 1].coverage.top3 - 1e-9);
      assert.ok(dist[i].coverage.top10 >= dist[i - 1].coverage.top10 - 1e-9);
      assert.ok(dist[i].coverage.top20 >= dist[i - 1].coverage.top20 - 1e-9);
    }
    const last = dist[dist.length - 1];
    // К горизонту доли приближаются к realism-целям.
    assert.ok(Math.abs(last.coverage.top3 - 0.15) < 0.02);
    assert.ok(Math.abs(last.coverage.top10 - 0.55) < 0.05);
  });

  test('traffic_realistic/optimistic берутся из unified value/upper', () => {
    const uf = unifiedStub();
    const dist = buildSemanticDistribution(keywords(), {
      unifiedForecast: uf,
      trafficEstimate: trafficEstimateStub(),
    });
    assert.strictEqual(dist[0].traffic_realistic, Math.round(uf.forecast[0].value));
    assert.strictEqual(dist[0].traffic_optimistic, Math.round(uf.forecast[0].upper));
  });

  test('fallback без unified: месяцы и трафик из trafficEstimate.top10', () => {
    const dist = buildSemanticDistribution(keywords(), {
      unifiedForecast: null,
      trafficEstimate: trafficEstimateStub(),
    });
    assert.strictEqual(dist.length, 12);
    assert.strictEqual(dist[0].traffic_realistic, 500);
    assert.strictEqual(dist[0].traffic_optimistic, 900);
  });

  test('стартовое распределение учитывает keysso (top10_pct)', () => {
    const dist = buildSemanticDistribution(keywords(), {
      unifiedForecast: unifiedStub(),
      trafficEstimate: trafficEstimateStub(),
      keyssoAggregate: { phrases_in_top10_pct: 40, phrases_in_top30_pct: 60 },
    });
    // На старте охват топ-10 не ниже ~40 %.
    assert.ok(dist[0].coverage.top10 >= 0.39);
  });

  test('пустое ядро → null', () => {
    assert.strictEqual(buildSemanticDistribution([], { unifiedForecast: unifiedStub() }), null);
    assert.strictEqual(buildSemanticDistribution(null, { unifiedForecast: unifiedStub() }), null);
  });

  test('нет ни unified, ни trafficEstimate → null', () => {
    assert.strictEqual(buildSemanticDistribution(keywords(), {}), null);
  });
});

group('forecastReport: _extractJson / _normalizeReport', () => {
  test('_extractJson режет markdown-обёртку и хвост', () => {
    const obj = _extractJson('```json\n{"executive_summary":"ok"}\n```\nспасибо!');
    assert.strictEqual(obj.executive_summary, 'ok');
  });

  test('_extractJson бросает на мусоре', () => {
    assert.throws(() => _extractJson('нет тут json'));
  });

  test('_normalizeReport валидирует схему и impact', () => {
    const rep = _normalizeReport({
      executive_summary: 'Суть прогноза.',
      growth_narrative: 'Рост за счёт S-кривой.',
      semantic_gap_analysis: 'Мало фраз в топ-10.',
      top_opportunities: [
        { title: 'Кластер А', description: 'Написать hub', impact: 'high' },
        { title: 'Кластер Б', description: '…', impact: 'невалидный' },
      ],
      risks: [{ title: 'Сезонность', description: 'Просадка летом' }],
      action_plan: [{ month_range: 'M1-M2', action: 'Контент-план', expected_effect: '+10%' }],
      confidence_comment: 'Средняя достоверность.',
    });
    assert.strictEqual(rep.top_opportunities[0].impact, 'high');
    assert.strictEqual(rep.top_opportunities[1].impact, 'medium'); // фолбэк
    assert.strictEqual(rep.action_plan[0].month_range, 'M1-M2');
  });

  test('_normalizeReport бросает без executive_summary', () => {
    assert.throws(() => _normalizeReport({ growth_narrative: 'x' }));
  });

  test('_buildContext собирает только агрегаты (без сырых строк)', () => {
    const ctx = _buildContext({
      target_url: 'https://ex.ru',
      options: { main_query: 'окна', region: 'Москва', current_traffic_per_month: 500 },
      forecast: { method: 'hw', horizon: 12, annual_total: 12000, points: [] },
      traffic_estimate: { current_traffic_input: 500, realism: {}, top3: {}, top5: {}, top10: {} },
      unified_forecast: { verdict: 'ok', horizon: 12, params: {}, summary: {}, explain: { summary: 's' } },
      keysso_signals: { verdict: 'ok', aggregate: { avg_current_position: 25, phrases_in_top10_pct: 10 } },
      monthly_series: { monthly: [{ period: '2025-01', demand: 1 }] },
      semantic_distribution: [{ month: 'M1' }],
    });
    assert.strictEqual(ctx.domain, 'https://ex.ru');
    assert.strictEqual(ctx.niche, 'окна');
    assert.strictEqual(ctx.currentMetrics.positions_avg, 25);
    assert.strictEqual(ctx.currentMetrics.top10_coverage, 10);
    assert.strictEqual(ctx.semanticDistribution.length, 1);
    assert.strictEqual(ctx.history_months, 1);
  });
});

console.log(`\n=== Result: ${passed} passed / ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
