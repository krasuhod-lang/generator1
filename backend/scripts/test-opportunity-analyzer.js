'use strict';

/**
 * test-opportunity-analyzer.js — smoke-тест для
 * backend/src/services/forecaster/opportunityAnalyzer.js
 *
 * Запуск:  node backend/scripts/test-opportunity-analyzer.js
 */

const assert = require('assert');
const { analyzeOpportunities, _phraseDynamics, _bigramCosine, _charBigrams, _median, _clusterPhrases } =
  require('../src/services/forecaster/opportunityAnalyzer');

let passed = 0, failed = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
}
function group(name, fn) { console.log(`\n— ${name} —`); fn(); }

// ── Фикстура: 12 месяцев, 5 фраз с разными профилями ────────────────
const monthCols = [
  '2024-06','2024-07','2024-08','2024-09','2024-10','2024-11',
  '2024-12','2025-01','2025-02','2025-03','2025-04','2025-05',
];
function mkRow(phrase, total, monthly) {
  const r = { phrase, total };
  monthCols.forEach((m, i) => { r[m] = monthly[i] || 0; });
  return r;
}

// drop case: фраза стабильна ~1000, потом обвал до 200
const dropRow = mkRow('купить пластиковые окна москва', 9000,
  [1000,1000,1100,1000,950,1000,1050,800,500,300,200,200]);
// growing — не должна попасть в opportunities (хотя isBigOffTop может)
const growRow = mkRow('установка балконных перегородок', 6000,
  [200,300,400,500,600,700,800,900,1000,1100,1200,1300]);
// flat low — мелкая, не должна попасть
const smallRow = mkRow('маленький запрос', 120,
  [10,10,10,10,10,10,10,10,10,10,10,10]);
// big off-top10 (без drop) — должна попасть
const bigOffTopRow = mkRow('пластиковые окна цена', 8000,
  [700,650,700,720,680,710,690,700,720,710,690,700]);
// noise phrase, не должна попасть (нет drop, нет big off-top)
const noiseRow = mkRow('какая-то узкая тема', 300,
  [25,25,25,25,25,25,25,25,25,25,25,25]);

const parsedRows = [dropRow, growRow, smallRow, bigOffTopRow, noiseRow];

// keys.so signals: bigOffTopRow позиция 18, drop — позиция 12
const keyssoMap = new Map([
  ['купить пластиковые окна москва', { current_position: 12, top10_competition: 0.6, demand_index: 9000, position_3m_delta: -1.5 }],
  ['пластиковые окна цена',          { current_position: 18, top10_competition: 0.7, demand_index: 8000, position_3m_delta: 0 }],
  ['установка балконных перегородок',{ current_position: 8,  top10_competition: 0.3, demand_index: 6000, position_3m_delta: 2 }],
]);

group('_median', () => {
  it('пустой → 0', () => { assert.strictEqual(_median([]), 0); });
  it('нечётное', () => { assert.strictEqual(_median([1,2,3]), 2); });
  it('чётное',   () => { assert.strictEqual(_median([1,2,3,4]), 2.5); });
});

group('_phraseDynamics', () => {
  it('drop detected', () => {
    const d = _phraseDynamics(dropRow, monthCols, 3);
    assert.ok(d.drop_pct > 0.5, `expected big drop_pct, got ${d.drop_pct}`);
    assert.ok(d.baseline >= 800, `baseline=${d.baseline}`);
    assert.ok(d.current < 400,   `current=${d.current}`);
  });
  it('growing → drop_pct = 0', () => {
    const d = _phraseDynamics(growRow, monthCols, 3);
    assert.strictEqual(d.drop_pct, 0);
  });
});

group('_bigramCosine', () => {
  it('идентичные строки → 1', () => {
    const a = _charBigrams('пластиковые окна');
    assert.ok(_bigramCosine(a, a) > 0.99);
  });
  it('близкие фразы → > 0.4', () => {
    const a = _charBigrams('купить пластиковые окна');
    const b = _charBigrams('пластиковые окна цена');
    const s = _bigramCosine(a, b);
    assert.ok(s > 0.4, `expected >0.4, got ${s}`);
  });
  it('разные → < 0.45 (значительно ниже близких)', () => {
    const a = _charBigrams('пластиковые окна');
    const b = _charBigrams('доставка пиццы суши');
    const sim = _bigramCosine(a, b);
    assert.ok(sim < 0.45, `expected <0.45, got ${sim}`);
  });
});

group('analyzeOpportunities (basic)', () => {
  const res = analyzeOpportunities({
    parsedRows,
    monthCols,
    keyssoSignalsMap: keyssoMap,
    conversionRate: 0.02,
  });
  it('verdict ok', () => { assert.strictEqual(res.verdict, 'ok'); });
  it('drop попала в opportunities', () => {
    const hit = res.opportunities.find((o) => o.phrase.includes('купить пластиковые'));
    assert.ok(hit, 'drop phrase missing');
    assert.ok(hit.drop_pct > 0.5);
  });
  it('big off-top попала в opportunities', () => {
    const hit = res.opportunities.find((o) => o.phrase === 'пластиковые окна цена');
    assert.ok(hit, 'big off-top missing');
  });
  it('мелкая/не-просевшая фраза не попала', () => {
    const hit = res.opportunities.find((o) => o.phrase === 'какая-то узкая тема');
    assert.ok(!hit, 'noise phrase should not be present');
  });
  it('summary заполнен', () => {
    assert.ok(res.summary.opportunities_total >= 2);
    assert.ok(res.summary.portfolio_best_annual_traffic > 0);
    assert.ok(res.summary.portfolio_best_annual_leads > 0);
    assert.ok(res.summary.portfolio_ci);
    assert.ok(res.summary.portfolio_ci.p90 > res.summary.portfolio_ci.p50);
  });
  it('scenarios считают traffic и leads', () => {
    const o = res.opportunities[0];
    assert.ok(o.scenarios.high.top3.expected_traffic_monthly > 0);
    assert.ok(o.scenarios.high.top3.expected_leads_monthly > 0);
    // high effort → больше traffic, чем low
    assert.ok(o.scenarios.high.top3.expected_traffic_monthly >
              o.scenarios.low.top10.expected_traffic_monthly);
  });
  it('calibration отдан', () => {
    assert.strictEqual(res.calibration.conversion_rate, 0.02);
    assert.strictEqual(res.calibration.conversion_rate_pct, 2);
  });
});

group('analyzeOpportunities (default CR / intent)', () => {
  it('CR=0 → default', () => {
    const r = analyzeOpportunities({ parsedRows, monthCols });
    assert.strictEqual(r.calibration.conversion_rate, 0.015);
  });
  it('intent=lead_gen → 3%', () => {
    const r = analyzeOpportunities({ parsedRows, monthCols, intent: 'lead_gen' });
    assert.strictEqual(r.calibration.conversion_rate, 0.030);
  });
  it('intent=info → 0.3%', () => {
    const r = analyzeOpportunities({ parsedRows, monthCols, intent: 'info' });
    assert.strictEqual(r.calibration.conversion_rate, 0.003);
  });
});

group('analyzeOpportunities (clustering)', () => {
  it('похожие фразы попадают в один кластер', () => {
    const res = analyzeOpportunities({ parsedRows, monthCols, keyssoSignalsMap: keyssoMap });
    const okna = res.opportunities.filter((o) => o.phrase.includes('окна'));
    if (okna.length >= 2) {
      const clusterIds = new Set(okna.map((o) => o.cluster_id));
      assert.strictEqual(clusterIds.size, 1, `expected same cluster, got ${[...clusterIds]}`);
    }
  });
  it('clusters[] не пуст', () => {
    const res = analyzeOpportunities({ parsedRows, monthCols, keyssoSignalsMap: keyssoMap });
    assert.ok(res.clusters.length >= 1);
    assert.ok(res.clusters[0].best_traffic_annual >= 0);
  });
});

group('analyzeOpportunities (edge cases)', () => {
  it('empty rows → skipped', () => {
    const r = analyzeOpportunities({ parsedRows: [], monthCols });
    assert.strictEqual(r.verdict, 'skipped');
  });
  it('< 3 месяцев → skipped', () => {
    const r = analyzeOpportunities({ parsedRows, monthCols: ['2024-01','2024-02'] });
    assert.strictEqual(r.verdict, 'skipped');
  });
  it('без keys.so — всё равно работает', () => {
    const r = analyzeOpportunities({ parsedRows, monthCols });
    assert.strictEqual(r.verdict, 'ok');
    // у opportunities current_position = null
    for (const o of r.opportunities) {
      assert.strictEqual(o.current_position, null);
    }
  });
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
