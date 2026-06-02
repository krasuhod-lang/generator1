'use strict';

/**
 * Smoke-тест коммерческого слоя модуля «Проекты»
 * (backend/src/services/projects/commercialIntent.js).
 * Детерминированный, без сети/LLM.
 *
 * Запуск: node backend/scripts/test-commercial-intent.js
 */

const assert = require('assert');
const {
  classifyQuery,
  deriveBrandTokens,
  analyzeCommercial,
  _expectedCtr,
} = require('../src/services/projects/commercialIntent');
const { getProjectsConfig } = require('../src/services/projects/config');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

// ── classifyQuery ────────────────────────────────────────────────────
test('transactional intent detected', () => {
  assert.strictEqual(classifyQuery('купить котёл недорого').intent, 'transactional');
  assert.strictEqual(classifyQuery('котёл цена').intent, 'transactional');
  assert.strictEqual(classifyQuery('buy boiler online').intent, 'transactional');
});

test('commercial (services) intent detected', () => {
  assert.strictEqual(classifyQuery('монтаж котла под ключ').intent, 'commercial');
  assert.strictEqual(classifyQuery('аренда оборудования').intent, 'commercial');
});

test('investigation intent detected', () => {
  assert.strictEqual(classifyQuery('лучшие котлы рейтинг').intent, 'investigation');
  assert.strictEqual(classifyQuery('навьен отзывы').intent, 'investigation');
  assert.strictEqual(classifyQuery('best boiler comparison').intent, 'investigation');
});

test('informational intent detected', () => {
  assert.strictEqual(classifyQuery('как выбрать котёл').intent, 'informational');
  assert.strictEqual(classifyQuery('что такое конденсационный котёл').intent, 'informational');
});

test('navigational intent detected', () => {
  assert.strictEqual(classifyQuery('теплодом официальный сайт').intent, 'navigational');
});

test('commercial flag matches commercial intents', () => {
  assert.strictEqual(classifyQuery('купить котёл').commercial, true);
  assert.strictEqual(classifyQuery('монтаж котла').commercial, true);
  assert.strictEqual(classifyQuery('лучшие котлы').commercial, true);
  assert.strictEqual(classifyQuery('как выбрать котёл').commercial, false);
});

test('transactional wins over informational when both present', () => {
  // «как купить» содержит и информационный, и транзакционный маркеры.
  assert.strictEqual(classifyQuery('как купить котёл').intent, 'transactional');
});

test('word-boundary match avoids false positives', () => {
  // «акция» не должно ловиться внутри «реакция».
  assert.notStrictEqual(classifyQuery('химическая реакция горения').intent, 'transactional');
});

test('ё/е normalization', () => {
  assert.strictEqual(classifyQuery('купить котел').intent, 'transactional');
  assert.strictEqual(classifyQuery('купить котёл').intent, 'transactional');
});

test('branded detection via brand tokens', () => {
  const r = classifyQuery('теплодом отзывы', { brandTokens: ['теплодом'] });
  assert.strictEqual(r.branded, true);
  const r2 = classifyQuery('котёл отзывы', { brandTokens: ['теплодом'] });
  assert.strictEqual(r2.branded, false);
});

// ── deriveBrandTokens ────────────────────────────────────────────────
test('deriveBrandTokens from name and host', () => {
  const t = deriveBrandTokens({ name: 'ТеплоДом', siteUrl: 'https://www.teplodom.ru' });
  assert.ok(t.includes('теплодом'));
  assert.ok(t.includes('teplodom'));
});

test('deriveBrandTokens drops short/stop tokens', () => {
  const t = deriveBrandTokens({ name: 'ИП и ООО для', siteUrl: 'https://ab.com' });
  assert.ok(!t.includes('ип'));
  assert.ok(!t.includes('для'));
  assert.ok(!t.includes('com'));
});

test('deriveBrandTokens handles empty input', () => {
  assert.deepStrictEqual(deriveBrandTokens({}), []);
  assert.deepStrictEqual(deriveBrandTokens(), []);
});

// ── _expectedCtr ─────────────────────────────────────────────────────
test('_expectedCtr uses benchmark table and decays', () => {
  const bench = getProjectsConfig().commercial.ctrBenchmark;
  assert.strictEqual(_expectedCtr(1, bench), bench[1]);
  assert.ok(_expectedCtr(1, bench) > _expectedCtr(10, bench));
  assert.ok(_expectedCtr(15, bench) < _expectedCtr(10, bench));
  assert.ok(_expectedCtr(50, bench) >= 0.005);
});

// ── analyzeCommercial ────────────────────────────────────────────────
function _sampleQueries() {
  return [
    { key: 'купить котёл', clicks: 10, impressions: 1000, ctr: 1.0, position: 8 },
    { key: 'как выбрать котёл', clicks: 50, impressions: 2000, ctr: 2.5, position: 3 },
    { key: 'теплодом', clicks: 30, impressions: 200, ctr: 15, position: 1 },
    { key: 'котёл цена', clicks: 5, impressions: 800, ctr: 0.6, position: 2 },
  ];
}

test('analyzeCommercial empty input is graceful', () => {
  const r = analyzeCommercial({});
  assert.strictEqual(r.available, false);
  assert.deepStrictEqual(r.intent_distribution, []);
  assert.deepStrictEqual(r.striking_distance, []);
  assert.deepStrictEqual(r.cannibalization, []);
});

test('analyzeCommercial computes commercial share', () => {
  const r = analyzeCommercial({ topQueries: _sampleQueries(), brandTokens: ['теплодом'] });
  assert.strictEqual(r.available, true);
  // commercial clicks = 10 (купить) + 5 (цена) = 15 of 95
  assert.ok(Math.abs(r.commercial_clicks_pct - 15.8) < 0.2, `got ${r.commercial_clicks_pct}`);
  assert.ok(r.branded_clicks_pct > 0);
});

test('analyzeCommercial finds striking distance commercial queries', () => {
  const r = analyzeCommercial({ topQueries: _sampleQueries() });
  // «купить котёл» позиция 8, impressions 1000 → striking distance
  assert.ok(r.striking_distance.some((x) => x.query === 'купить котёл'));
  // «как выбрать котёл» — информационный, не должен попадать
  assert.ok(!r.striking_distance.some((x) => x.query === 'как выбрать котёл'));
});

test('analyzeCommercial flags CTR anomalies', () => {
  const r = analyzeCommercial({ topQueries: _sampleQueries() });
  // «котёл цена» позиция 2, CTR 0.6% << ожидаемого → аномалия
  assert.ok(r.ctr_anomalies.some((x) => x.query === 'котёл цена'));
});

test('analyzeCommercial detects cannibalization', () => {
  const r = analyzeCommercial({
    topQueries: _sampleQueries(),
    queryPage: [
      { query: 'купить котёл', page: 'https://x.ru/a', clicks: 4, impressions: 500, ctr: 0.8, position: 9 },
      { query: 'купить котёл', page: 'https://x.ru/b', clicks: 6, impressions: 500, ctr: 1.2, position: 12 },
    ],
    brandTokens: [],
  });
  assert.strictEqual(r.cannibalization.length, 1);
  assert.strictEqual(r.cannibalization[0].query, 'купить котёл');
  assert.strictEqual(r.cannibalization[0].pages.length, 2);
});

test('no cannibalization when a page is in top-3', () => {
  const r = analyzeCommercial({
    topQueries: _sampleQueries(),
    queryPage: [
      { query: 'купить котёл', page: 'https://x.ru/a', clicks: 4, impressions: 500, ctr: 0.8, position: 2 },
      { query: 'купить котёл', page: 'https://x.ru/b', clicks: 6, impressions: 500, ctr: 1.2, position: 12 },
    ],
  });
  assert.strictEqual(r.cannibalization.length, 0);
});

test('analyzeCommercial detects intent mismatch (commercial → info page)', () => {
  const r = analyzeCommercial({
    topQueries: _sampleQueries(),
    queryPage: [
      { query: 'купить котёл', page: 'https://x.ru/blog/kotel', clicks: 6, impressions: 500, ctr: 1.2, position: 9 },
    ],
  });
  assert.strictEqual(r.intent_mismatch.length, 1);
  assert.strictEqual(r.intent_mismatch[0].landing_page, 'https://x.ru/blog/kotel');
});

test('no intent mismatch when a commerce page also ranks', () => {
  const r = analyzeCommercial({
    topQueries: _sampleQueries(),
    queryPage: [
      { query: 'купить котёл', page: 'https://x.ru/blog/kotel', clicks: 6, impressions: 500, ctr: 1.2, position: 9 },
      { query: 'купить котёл', page: 'https://x.ru/catalog/kotel', clicks: 2, impressions: 300, ctr: 0.6, position: 14 },
    ],
  });
  assert.strictEqual(r.intent_mismatch.length, 0);
});

test('informational queries ignored in query×page detectors', () => {
  const r = analyzeCommercial({
    topQueries: _sampleQueries(),
    queryPage: [
      { query: 'как выбрать котёл', page: 'https://x.ru/blog/a', clicks: 4, impressions: 500, ctr: 0.8, position: 9 },
      { query: 'как выбрать котёл', page: 'https://x.ru/blog/b', clicks: 6, impressions: 500, ctr: 1.2, position: 12 },
    ],
  });
  assert.strictEqual(r.cannibalization.length, 0);
  assert.strictEqual(r.intent_mismatch.length, 0);
});

// ── summary ──────────────────────────────────────────────────────────
// eslint-disable-next-line no-console
console.log(`\nCommercial-intent smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
