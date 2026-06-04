'use strict';

/**
 * Smoke-тест GEO/AEO слоя (п.7 ТЗ). Детерминированный + мок SERP.
 * Запуск: node backend/scripts/test-geo-aeo.js
 */

const assert = require('assert');
const { buildAeo } = require('../src/services/projects/geoAeo/aeoOptimizer');
const { probeAiVisibility, _domainOf } = require('../src/services/projects/geoAeo/aiVisibilityProbe');
const { buildGeoAeo } = require('../src/services/projects/geoAeo');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const topQueries = [
  { key: 'как выбрать насос', impressions: 500, position: 12 },
  { key: 'купить насос', impressions: 800, position: 6 },
];
const schemaAudit = { items: [{ template: 'catalog', present_types: ['Organization', 'BreadcrumbList'] }] };
const breakdowns = { country: [{ key: 'rus', impressions: 5000 }, { key: 'kaz', impressions: 300 }] };

// ── buildAeo ────────────────────────────────────────────────────────
test('buildAeo produces AEO answer formats per query', () => {
  const aeo = buildAeo({ topQueries, schemaAudit, breakdowns, brandTokens: [] });
  assert.strictEqual(aeo.aeo_answers.length, 2);
  assert.ok(aeo.aeo_answers[0].answer_format.tldr);
  assert.ok(Array.isArray(aeo.aeo_answers[0].answer_format.structure));
});

test('buildAeo detects missing AI-critical schema types', () => {
  const aeo = buildAeo({ topQueries, schemaAudit, breakdowns, brandTokens: [] });
  assert.ok(aeo.missing_schema.includes('FAQPage'));
  assert.ok(aeo.missing_schema.includes('Article'));
  assert.ok(aeo.recommendations.some((r) => r.kind === 'schema'));
});

test('buildAeo recommends hreflang on multi-country demand', () => {
  const aeo = buildAeo({ topQueries, schemaAudit, breakdowns, brandTokens: [] });
  assert.ok(aeo.geo.length >= 1);
  assert.ok(aeo.recommendations.some((r) => r.kind === 'hreflang'));
});

// ── _domainOf ───────────────────────────────────────────────────────
test('_domainOf normalizes hostnames', () => {
  assert.strictEqual(_domainOf('https://www.aquashop.ru/x'), 'aquashop.ru');
  assert.strictEqual(_domainOf('aquashop.ru'), 'aquashop.ru');
});

// ── probeAiVisibility / buildGeoAeo are async — tested in async block below ──

(async () => {
  // run async tests sequentially via simple wrapper
  const asyncTests = [
    ['probeAiVisibility detects our domain in top via injected fetch', async () => {
      const fake = async () => [{ url: 'https://aquashop.ru/x' }, { url: 'https://other.ru' }];
      const v = await probeAiVisibility({ project: { gsc_site_url: 'https://aquashop.ru' }, topQueries, fetchSerp: fake });
      assert.strictEqual(v.data_source, 'serp');
      assert.ok(v.probes.every((p) => p.sge_includes_us === true));
    }],
    ['probeAiVisibility graceful inferred without working fetch', async () => {
      const v = await probeAiVisibility({ project: { url: 'https://aquashop.ru' }, topQueries, fetchSerp: () => { throw new Error('no net'); } });
      assert.strictEqual(v.available, true);
    }],
    ['buildGeoAeo returns aeo without probe by default', async () => {
      const g = await buildGeoAeo({ project: { url: 'https://aquashop.ru' }, topQueries, schemaAudit, breakdowns, brandTokens: [] });
      assert.strictEqual(g.available, true);
      assert.strictEqual(g.ai_visibility, null);
    }],
    ['buildGeoAeo runs probe when requested', async () => {
      const fake = async () => [{ url: 'https://aquashop.ru/x' }];
      const g = await buildGeoAeo({ project: { url: 'https://aquashop.ru' }, topQueries, schemaAudit, breakdowns, brandTokens: [], runProbe: true, fetchSerp: fake });
      assert.ok(g.ai_visibility && Array.isArray(g.ai_visibility.probes));
    }],
  ];
  for (const [name, fn] of asyncTests) {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
  }
  console.log(`\nGEO/AEO smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
