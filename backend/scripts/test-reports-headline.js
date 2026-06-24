'use strict';

/* Tests for reports/headlineBuilder — Sprint 2 client-first layout. */

const assert = require('assert');
const { buildHeadline, _internal } = require('../src/services/reports/headlineBuilder');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name, '\n     ', e.message); }
}

console.log('── buildHeadline ──────────────────────────────');

test('Google+Яндекс клики → main_kpi суммируется, delta считается по полупериодам', () => {
  const data = {
    gsc: {
      totals: { clicks: 600, impressions: 10000, ctr: 6 },
      series: [
        { date: '2026-01-01', clicks: 100 },
        { date: '2026-02-01', clicks: 100 },
        { date: '2026-03-01', clicks: 200 },
        { date: '2026-04-01', clicks: 200 },
      ],
    },
    ywm: {
      totals: { clicks: 400, impressions: 5000 },
      series: [
        { date: '2026-01-01', clicks: 50 },
        { date: '2026-02-01', clicks: 50 },
        { date: '2026-03-01', clicks: 150 },
        { date: '2026-04-01', clicks: 150 },
      ],
    },
  };
  const h = buildHeadline(data);
  assert.strictEqual(h.main_kpi.label, 'Клики из поиска');
  assert.strictEqual(h.main_kpi.value, 1000);
  assert.strictEqual(h.main_kpi.unit, 'клик.');
  assert.ok(h.main_kpi.source.includes('Google'));
  assert.ok(h.main_kpi.source.includes('Яндекс'));
  // prev sum = (100+50)+(100+50) = 300; curr = (200+150)+(200+150) = 700; delta +400 +133.3%
  assert.strictEqual(h.delta.direction, 'up');
  assert.strictEqual(h.delta.abs, 400);
  assert.strictEqual(h.delta.pct, 133.3);
  assert.ok(/Клики из поиска/.test(h.change_summary));
  assert.ok(/выросли/i.test(h.change_summary));
});

test('нет кликов → fallback на keys_so.visibility', () => {
  const data = {
    gsc: { totals: { clicks: 0 } },
    ywm: { totals: { clicks: 0 } },
    keys_so: { yandex: { current: { visibility: 12.5 } } },
  };
  const h = buildHeadline(data);
  assert.strictEqual(h.main_kpi.label, 'Видимость в Keys.so');
  assert.strictEqual(h.main_kpi.value, 12.5);
});

test('нет кликов и нет visibility → fallback на position.top10', () => {
  const data = { position: { summary: { top10: 42 } } };
  const h = buildHeadline(data);
  assert.strictEqual(h.main_kpi.label, 'Запросов в ТОП-10');
  assert.strictEqual(h.main_kpi.value, 42);
});

test('пустой data → main_kpi=null, change_summary fallback', () => {
  const h = buildHeadline({});
  assert.strictEqual(h.main_kpi, null);
  assert.strictEqual(h.delta, null);
  assert.ok(/нет/i.test(h.change_summary));
  assert.deepStrictEqual(h.secondary_kpis, []);
  assert.deepStrictEqual(h.top_achievements, []);
  assert.deepStrictEqual(h.top_risks, []);
});

test('secondary_kpis: <=4 элементов, не дублирует main_kpi', () => {
  const data = {
    gsc: { totals: { clicks: 100, impressions: 5000, ctr: 2 } },
    ywm: { totals: { clicks: 50, impressions: 2000 } },
    keys_so: { yandex: { current: { top10: 30 } } },
    position: { summary: { avg_position: 8.7 } },
  };
  const h = buildHeadline(data);
  assert.ok(h.secondary_kpis.length <= 4);
  // main_kpi = "Клики из поиска" — его не должно быть в secondary
  for (const k of h.secondary_kpis) {
    assert.notStrictEqual(k.label, 'Клики из поиска');
  }
  const labels = h.secondary_kpis.map((k) => k.label);
  assert.ok(labels.includes('Показы в Google'));
  assert.ok(labels.includes('CTR Google'));
});

test('top_achievements: highlights имеют приоритет, потом delta', () => {
  const data = {
    gsc: { totals: { clicks: 200 }, series: [
      { date: '2026-01-01', clicks: 50 }, { date: '2026-02-01', clicks: 150 },
    ] },
  };
  const summary = { highlights: ['Запущена SEO-стратегия', 'Новые статьи в блоге'] };
  const h = buildHeadline(data, summary);
  assert.strictEqual(h.top_achievements[0], 'Запущена SEO-стратегия');
  assert.strictEqual(h.top_achievements[1], 'Новые статьи в блоге');
  // 3-й элемент должен быть про рост трафика (delta up)
  assert.ok(/трафик/i.test(h.top_achievements[2]));
  assert.ok(h.top_achievements.length <= 3);
});

test('top_risks: failed_sources имеют приоритет над vulnerabilities', () => {
  const data = {
    completeness: { failed_sources: ['Keys.so'], partial_sources: ['GSC'], has_error: true, has_partial: true },
    gsc: { totals: { clicks: 100 }, series: [
      { date: '2026-01-01', clicks: 80 }, { date: '2026-02-01', clicks: 20 },
    ] },
  };
  const summary = { vulnerabilities: ['Нет мобильной версии'] };
  const h = buildHeadline(data, summary);
  assert.ok(/Keys\.so/.test(h.top_risks[0]));
  // потом vulnerabilities или delta down
  const joined = h.top_risks.join(' | ');
  assert.ok(/Нет мобильной версии|снизился/.test(joined));
  assert.ok(h.top_risks.length <= 3);
});

test('completeness_note: только при наличии failed/partial', () => {
  assert.strictEqual(buildHeadline({}).completeness_note, null);
  const h = buildHeadline({
    completeness: { has_error: true, failed_sources: ['Keys.so'], partial_sources: [] },
  });
  assert.ok(/Keys\.so/.test(h.completeness_note));
});

test('не мутирует входной data/summary', () => {
  const data = { gsc: { totals: { clicks: 10 } } };
  const before = JSON.stringify(data);
  buildHeadline(data, { highlights: ['x'] });
  assert.strictEqual(JSON.stringify(data), before);
});

test('delta: prev=0, curr>0 → pct=null, direction=up', () => {
  const d = _internal._delta(0, 100);
  assert.strictEqual(d.direction, 'up');
  assert.strictEqual(d.abs, 100);
  assert.strictEqual(d.pct, null);
});

test('_formatDeltaLabel: знаки и проценты', () => {
  // toLocaleString('ru-RU') использует U+00A0 (NBSP) для тысячных разрядов,
  // поэтому сверяем по regex, а не строго.
  const up = _internal._formatDeltaLabel({ abs: 1240, pct: 24, direction: 'up' }, { unit: 'клик.' });
  assert.ok(/^\+1.240 клик\. \(\+24%\)$/.test(up), `unexpected: ${up}`);
  assert.strictEqual(
    _internal._formatDeltaLabel({ abs: -50, pct: -10, direction: 'down' }),
    '-50 (-10%)',
  );
});

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed === 0 ? 0 : 1);
