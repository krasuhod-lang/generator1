'use strict';

/**
 * Smoke-тест E-E-A-T слоя (п.5 ТЗ). Детерминированный, без сети.
 * Запуск: node backend/scripts/test-eat-scorer.js
 */

const assert = require('assert');
const { classifyTemplate, classifyTemplates } = require('../src/services/projects/eatAnalyzer/templateClassifier');
const { detectBlocks, collectJsonLdTypes } = require('../src/services/projects/eatAnalyzer/blockDetector');
const { scoreEat, scoreLabel } = require('../src/services/projects/eatAnalyzer/eatScorer');
const { getProjectsConfig } = require('../src/services/projects/config');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const cfg = getProjectsConfig().eat;

// ── classifyTemplate ────────────────────────────────────────────────
test('classifyTemplate maps URL patterns to templates', () => {
  assert.strictEqual(classifyTemplate('https://x.ru/catalog/nasos', cfg.templatePatterns), 'catalog');
  assert.strictEqual(classifyTemplate('https://x.ru/uslugi/montazh', cfg.templatePatterns), 'service');
  assert.strictEqual(classifyTemplate('https://x.ru/blog/guide', cfg.templatePatterns), 'blog');
});

test('classifyTemplates clusters top pages by template', () => {
  const { clusters } = classifyTemplates([
    { key: 'https://x.ru/catalog/a', impressions: 100 },
    { key: 'https://x.ru/catalog/b', impressions: 80 },
    { key: 'https://x.ru/blog/c', impressions: 50 },
  ], cfg);
  assert.ok(clusters.length >= 2);
  const catalog = clusters.find((c) => c.template === 'catalog');
  assert.ok(catalog && catalog.total >= 2);
});

// ── collectJsonLdTypes ──────────────────────────────────────────────
test('collectJsonLdTypes walks @graph and arrays', () => {
  const types = collectJsonLdTypes({ '@graph': [{ '@type': 'Organization' }, { '@type': ['Product', 'Offer'] }] });
  assert.ok(types.includes('Organization'));
  assert.ok(types.includes('Product'));
  assert.ok(types.includes('Offer'));
});

// ── detectBlocks ────────────────────────────────────────────────────
test('detectBlocks detects text blocks and schema', () => {
  const detected = detectBlocks({
    title: 'Купить насос',
    markdown: '# Насос\nОтзывы клиентов: ... Гарантия 2 года. Контакты: +7... ![photo](img.jpg)',
    hiddenLayers: { structured_data: { jsonld: [{ '@type': 'BreadcrumbList' }] } },
  });
  assert.strictEqual(detected.blocks.reviews, true);
  assert.strictEqual(detected.blocks.guarantees, true);
  assert.strictEqual(detected.has_media, true);
  assert.strictEqual(detected.has_breadcrumb_schema, true);
});

// ── scoreEat ────────────────────────────────────────────────────────
test('scoreEat returns 0..100 across 4 dimensions', () => {
  const detected = detectBlocks({ markdown: 'пусто', hiddenLayers: {} });
  const eat = scoreEat(detected, { hasBacklinks: false, template: 'catalog' });
  assert.ok(eat.score >= 0 && eat.score <= 100);
  assert.ok(['experience', 'expertise', 'authoritativeness', 'trust'].every((d) => d in eat.dimensions));
  assert.ok(eat.gaps.length > 0);
});

test('scoreEat rewards rich page with backlinks higher', () => {
  const poor = scoreEat(detectBlocks({ markdown: 'пусто', hiddenLayers: {} }), { hasBacklinks: false });
  const rich = scoreEat(detectBlocks({
    title: 'X',
    markdown: 'Автор статьи: Иван. Отзывы. Сертификат. Гарантия. Контакты. ИНН 123. FAQ. ![i](a.jpg)',
    hiddenLayers: { structured_data: { jsonld: [{ '@type': 'Person' }, { '@type': 'BreadcrumbList' }] } },
  }), { hasBacklinks: true });
  assert.ok(rich.score > poor.score);
});

test('scoreLabel maps scores to labels', () => {
  assert.strictEqual(scoreLabel(85), 'сильный');
  assert.strictEqual(scoreLabel(65), 'хороший');
  assert.strictEqual(scoreLabel(10), 'критически слабый');
});

console.log(`\nE-E-A-T smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
