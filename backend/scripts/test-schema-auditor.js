'use strict';

/**
 * Smoke-тест аудита микроразметки (п.8 ТЗ). Детерминированный, без сети.
 * Запуск: node backend/scripts/test-schema-auditor.js
 */

const assert = require('assert');
const { flattenJsonLdObjects, validateObject, inventoryTemplate } = require('../src/services/projects/schemaAuditor/schemaInventory');
const { recommendSchema } = require('../src/services/projects/schemaAuditor/schemaRecommender');
const { auditSchema } = require('../src/services/projects/schemaAuditor');
const { getProjectsConfig } = require('../src/services/projects/config');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const cfg = getProjectsConfig().schemaAudit;

// ── flattenJsonLdObjects ────────────────────────────────────────────
test('flattenJsonLdObjects extracts objects from @graph', () => {
  const objs = flattenJsonLdObjects({ '@graph': [{ '@type': 'Product', name: 'X' }, { '@type': 'Offer', price: '10' }] });
  assert.ok(objs.length >= 2);
});

// ── validateObject ──────────────────────────────────────────────────
test('validateObject flags missing required fields', () => {
  const issues = validateObject({ '@type': 'Product', name: 'X' }, cfg.requiredFields);
  assert.ok(issues.some((i) => /image|offers/.test(JSON.stringify(i))));
});

test('validateObject passes complete object', () => {
  const issues = validateObject({ '@type': 'Organization', name: 'X', url: 'https://x.ru' }, cfg.requiredFields);
  assert.strictEqual(issues.length, 0);
});

// ── inventoryTemplate ───────────────────────────────────────────────
test('inventoryTemplate computes missing types per template', () => {
  const inv = inventoryTemplate(
    { template: 'product', sample_url: 'https://x.ru/p/1', schema_types: ['Product'] },
    { structured_data: { jsonld: [{ '@type': 'Product', name: 'X' }] } },
    cfg,
  );
  assert.ok(inv.missing_types.includes('Offer'));
  assert.ok(inv.present_types.includes('Product'));
});

// ── recommendSchema ─────────────────────────────────────────────────
test('recommendSchema builds actions + JSON-LD snippets', () => {
  const inventories = [{
    template: 'blog', sample_url: 'https://x.ru/blog/a',
    present_types: [], missing_types: ['Article', 'FAQPage'], broken_fields: [],
  }];
  const r = recommendSchema(inventories, { siteUrl: 'https://x.ru', projectName: 'X' });
  assert.strictEqual(r.available, true);
  assert.strictEqual(r.items.length, 1);
  assert.ok(r.summary.missing_types >= 2);
});

// ── auditSchema end-to-end ──────────────────────────────────────────
test('auditSchema consumes eatResult with _scans', () => {
  const eatResult = {
    available: true,
    templates: [{ template: 'product', sample_url: 'https://x.ru/p/1', schema_types: ['Product'] }],
    _scans: [{ template: 'product', sample_url: 'https://x.ru/p/1', hiddenLayers: { structured_data: { jsonld: [{ '@type': 'Product', name: 'X' }] } } }],
  };
  const r = auditSchema({ eatResult, project: { name: 'X', url: 'https://x.ru' } });
  assert.strictEqual(r.available, true);
  assert.ok(r.items[0].missing_types.length >= 1);
});

test('auditSchema returns no_eat_data without eat', () => {
  const r = auditSchema({ eatResult: null, project: {} });
  assert.strictEqual(r.available, false);
});

console.log(`\nSchema-auditor smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
