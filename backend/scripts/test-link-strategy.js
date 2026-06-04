'use strict';

/**
 * Smoke-тест ссылочного слоя модуля «Проекты» (п.1, п.2 ТЗ).
 * Детерминированный, без сети/LLM.
 * Запуск: node backend/scripts/test-link-strategy.js
 */

const assert = require('assert');
const { classifyAnchor, analyzeAnchors, findOrphanPages } = require('../src/services/projects/linkStrategy/anchorAnalyzer');
const { scoreDonors } = require('../src/services/projects/linkStrategy/donorScorer');
const { auditLinks } = require('../src/services/projects/linkStrategy/linkAuditor');
const { recommendLinks } = require('../src/services/projects/linkStrategy/linkRecommender');
const { importLinksCsv, detectTableType } = require('../src/services/projects/linkStrategy/linksImporter');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const project = { id: '00000000-0000-0000-0000-000000000001', name: 'AquaShop', url: 'https://aquashop.ru', gsc_site_url: 'https://aquashop.ru' };

// ── classifyAnchor ──────────────────────────────────────────────────
test('classifyAnchor detects branded/commercial/naked/generic', () => {
  assert.strictEqual(classifyAnchor('AquaShop', ['aquashop']), 'branded');
  assert.strictEqual(classifyAnchor('купить насос', ['aquashop']), 'commercial');
  assert.strictEqual(classifyAnchor('https://aquashop.ru', []), 'naked');
  assert.strictEqual(classifyAnchor('тут', []), 'generic');
  assert.strictEqual(classifyAnchor('', []), 'empty');
});

// ── analyzeAnchors ──────────────────────────────────────────────────
test('analyzeAnchors computes distribution + warnings', () => {
  const r = analyzeAnchors([
    { anchor: 'купить насос', links: 120 },
    { anchor: 'AquaShop', links: 30 },
    { anchor: 'тут', links: 10 },
  ], ['aquashop']);
  assert.ok(r.distribution.commercial_pct > 50);
  assert.ok(r.warnings.length >= 1);
  assert.strictEqual(r.total_links, 160);
});

test('analyzeAnchors empty input → not available', () => {
  const r = analyzeAnchors([], []);
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.total_links, 0);
});

// ── findOrphanPages ─────────────────────────────────────────────────
test('findOrphanPages finds pages without backlinks', () => {
  const { orphans, linkedSet } = findOrphanPages(
    [{ key: 'https://aquashop.ru/catalog/nasos', impressions: 900 }, { key: 'https://aquashop.ru/blog/guide', impressions: 100 }],
    [{ target_page: 'https://aquashop.ru/blog/guide', links: 3 }],
  );
  assert.strictEqual(orphans.length, 1);
  assert.strictEqual(orphans[0].url, 'https://aquashop.ru/catalog/nasos');
  assert.ok(linkedSet.size >= 1);
});

// ── scoreDonors ─────────────────────────────────────────────────────
test('scoreDonors ranks trusted above risky', () => {
  const scored = scoreDonors([
    { donor: 'gov.ru', links: 5 },
    { donor: 'spam.blogspot.com', links: 2 },
    { donor: 'news.ru', links: 40 },
  ]);
  assert.strictEqual(scored[0].host, 'gov.ru');
  const risky = scored.find((d) => d.host === 'spam.blogspot.com');
  assert.ok(risky.flags.includes('risky_host'));
});

// ── auditLinks ──────────────────────────────────────────────────────
test('auditLinks produces issues and data_source', () => {
  const audit = auditLinks({
    project,
    links: {
      anchors: [{ anchor: 'купить насос', links: 120 }],
      pages: [{ target_page: 'https://aquashop.ru/blog/guide', links: 3 }],
      sites: [{ donor: 'spam.blogspot.com', links: 2 }],
    },
    topPages: [{ key: 'https://aquashop.ru/catalog/nasos', impressions: 900 }],
  });
  assert.strictEqual(audit.data_source, 'gsc_csv');
  assert.ok(Array.isArray(audit.issues));
  assert.ok(Array.isArray(audit.donors));
});

// ── recommendLinks: ВСЕГДА ≥5 (ключевое требование ТЗ) ───────────────
test('recommendLinks always returns >= 5 recommendations', () => {
  const audit = auditLinks({ project, links: { anchors: [], pages: [], sites: [] }, topPages: [] });
  const rec = recommendLinks({ project, commercial: null, linkAudit: audit, topPages: [] });
  assert.ok(rec.recommendations.length >= 5, `got ${rec.recommendations.length}`);
  rec.recommendations.forEach((r) => {
    assert.ok(r.anchor && r.target_url && r.donor_topic);
  });
});

test('recommendLinks marks inferred when no link data', () => {
  const audit = auditLinks({ project, links: { anchors: [], pages: [], sites: [] }, topPages: [{ key: 'https://aquashop.ru/x', impressions: 50 }] });
  const rec = recommendLinks({ project, commercial: null, linkAudit: audit, topPages: [{ key: 'https://aquashop.ru/x', impressions: 50 }] });
  assert.strictEqual(rec.data_source, 'inferred');
  assert.ok(rec.recommendations.length >= 5);
});

test('recommendLinks uses striking distance commercial queries', () => {
  const audit = auditLinks({ project, links: { anchors: [], pages: [], sites: [] }, topPages: [] });
  const rec = recommendLinks({
    project,
    commercial: { striking_distance: [{ query: 'насос для дачи', position: 12, landing_page: 'https://aquashop.ru/catalog/nasos' }] },
    linkAudit: audit,
    topPages: [],
  });
  assert.ok(rec.recommendations.some((r) => r.target_url.includes('/catalog/nasos')));
});

// ── importLinksCsv ──────────────────────────────────────────────────
test('importLinksCsv detects anchors table', () => {
  const r = importLinksCsv('Top linking text,Links\nкупить насос,120\nAquaShop,30\n');
  assert.strictEqual(r.type, 'anchors');
  assert.strictEqual(r.count, 2);
});

test('importLinksCsv detects sites and pages tables', () => {
  const s = importLinksCsv('Top linking sites,Linking pages\nnews.ru,40\n');
  assert.strictEqual(s.type, 'sites');
  const p = importLinksCsv('Top linked pages;Links\nhttps://x.ru/a;12\n');
  assert.strictEqual(p.type, 'pages');
});

test('detectTableType returns unknown for unrelated header', () => {
  assert.strictEqual(detectTableType(['Foo', 'Bar']), 'unknown');
});

// ── summary ──────────────────────────────────────────────────────────
console.log(`\nLink-strategy smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
