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
const _queue = [];
function test(name, fn) { _queue.push({ name, fn }); }

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

// ── п.1 ТЗ: анкор = поисковый запрос из GSC, а не окончание URL ───────
test('recommendLinks uses real GSC query as anchor for orphans (not URL slug)', () => {
  const orphanUrl = 'https://aquashop.ru/catalog/nasos-dlya-skvazhiny';
  const audit = auditLinks({
    project,
    links: { anchors: [], pages: [], sites: [] },
    topPages: [{ key: orphanUrl, impressions: 900 }],
  });
  const rec = recommendLinks({
    project,
    commercial: null,
    linkAudit: audit,
    topPages: [{ key: orphanUrl, impressions: 900 }],
    queryPage: [
      { query: 'насос для скважины купить', page: orphanUrl, impressions: 500 },
      { query: 'погружной насос', page: orphanUrl, impressions: 120 },
    ],
  });
  const orphanRec = rec.recommendations.find((r) => r.target_url === orphanUrl);
  assert.ok(orphanRec, 'orphan recommendation present');
  assert.strictEqual(orphanRec.anchor, 'насос для скважины купить');
  // анкор НЕ должен быть окончанием URL
  assert.ok(!orphanRec.anchor.includes('nasos-dlya'), 'anchor is not the URL slug');
});

test('recommendLinks falls back to slug anchor when no GSC query for page', () => {
  const url = 'https://aquashop.ru/x';
  const audit = auditLinks({ project, links: { anchors: [], pages: [], sites: [] }, topPages: [{ key: url, impressions: 50 }] });
  const rec = recommendLinks({
    project, commercial: null, linkAudit: audit,
    topPages: [{ key: url, impressions: 50 }], queryPage: [],
  });
  assert.ok(rec.recommendations.length >= 5);
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

// ── donorTopicGenerator: готовые темы статей под анкор ───────────────
const { wrapDonorTopic } = require('../src/services/projects/linkStrategy/linkRecommender');
const { enrichDonorTopics } = require('../src/services/projects/linkStrategy/donorTopicGenerator');

test('wrapDonorTopic keeps the required external format', () => {
  assert.strictEqual(
    wrapDonorTopic('греется тормозной диск с одной стороны'),
    'Экспертная статья по теме «греется тормозной диск с одной стороны» с естественной ссылкой на ваш раздел',
  );
});

function _orphanRecs() {
  const url = 'https://aquashop.ru/catalog/nasos-dlya-skvazhiny';
  const audit = auditLinks({ project, links: { anchors: [], pages: [], sites: [] }, topPages: [{ key: url, impressions: 900 }] });
  return recommendLinks({
    project, commercial: null, linkAudit: audit,
    topPages: [{ key: url, impressions: 900 }],
    queryPage: [{ query: 'насос для скважины купить', page: url, impressions: 500 }],
  }).recommendations;
}

test('enrichDonorTopics without llmFn keeps deterministic wrapper + format', async () => {
  const recs = _orphanRecs();
  const before = recs.map((r) => r.donor_topic);
  const res = await enrichDonorTopics({ recommendations: recs, project, llmFn: null });
  assert.strictEqual(res.enriched, 0);
  assert.strictEqual(res.used_llm, false);
  recs.forEach((r, i) => {
    assert.strictEqual(r.donor_topic, before[i]); // не тронуто
    assert.ok(r.donor_topic_ready === undefined);
  });
  // Тематическая (seed) рекомендация сохраняет обязательный формат-обёртку.
  const seedRec = recs.find((r) => r.donor_topic_seed);
  assert.ok(seedRec, 'has a thematic seed recommendation');
  assert.ok(/^Экспертная статья по теме «.*» с естественной ссылкой на ваш раздел$/.test(seedRec.donor_topic));
  assert.ok(recs.length >= 5);
});

test('enrichDonorTopics with llmFn fills ready topic, still wrapped in format', async () => {
  const recs = _orphanRecs();
  const seedRec = recs.find((r) => r.donor_topic_seed);
  assert.ok(seedRec, 'has a thematic seed recommendation');
  const fakeLlm = async () => JSON.stringify(
    recs.filter((r) => r.donor_topic_seed).map((r) => ({
      ready_topic: `Как устранить «${r.donor_topic_seed}»: гид эксперта`,
      h1: `Гид: ${r.donor_topic_seed}`,
      title: `Почему «${r.donor_topic_seed}» — и что с этим делать сегодня`,
      description: `Разбираем причины и быстрые решения «${r.donor_topic_seed}» простыми словами, с чек-листом для самостоятельной диагностики и выбора.`,
      angle: 'Пошаговая диагностика и выбор решения',
    })),
  );
  const res = await enrichDonorTopics({ recommendations: recs, project, llmFn: fakeLlm });
  assert.ok(res.used_llm);
  assert.ok(res.enriched >= 1, `enriched ${res.enriched}`);
  const enriched = recs.find((r) => r.donor_topic_ready);
  assert.ok(enriched.donor_topic_ready.startsWith('Как устранить'));
  assert.ok(enriched.donor_topic_angle);
  // ТЗ п.3: title и description заполнены, title не дублирует тему.
  assert.ok(enriched.donor_topic_title, 'title filled');
  assert.ok(enriched.donor_topic_description, 'description filled');
  assert.notStrictEqual(enriched.donor_topic_title, enriched.donor_topic_ready);
  // Итоговая строка обёрнута в обязательный формат и содержит готовую тему.
  assert.strictEqual(enriched.donor_topic, wrapDonorTopic(enriched.donor_topic_ready));
  assert.ok(enriched.donor_topic.includes('Как устранить'));
});

test('enrichDonorTopics drops title that duplicates the topic (must intrigue, not repeat)', async () => {
  const recs = _orphanRecs();
  const fakeLlm = async () => JSON.stringify(
    recs.filter((r) => r.donor_topic_seed).map((r) => ({
      ready_topic: `Тема про ${r.donor_topic_seed}`,
      // title дословно равен теме → должен быть отброшен safeguard'ом.
      title: `Тема про ${r.donor_topic_seed}`,
      description: 'Короткое описание статьи для проверки.',
    })),
  );
  await enrichDonorTopics({ recommendations: recs, project, llmFn: fakeLlm });
  const enriched = recs.find((r) => r.donor_topic_ready);
  assert.ok(enriched, 'has enriched rec');
  assert.strictEqual(enriched.donor_topic_title, undefined, 'duplicate title dropped');
  // description при этом сохраняется.
  assert.ok(enriched.donor_topic_description);
});

test('enrichDonorTopics graceful on broken llm output → keeps fallback', async () => {
  const recs = _orphanRecs();
  const before = recs.map((r) => r.donor_topic);
  const badLlm = async () => 'не json вовсе';
  const res = await enrichDonorTopics({ recommendations: recs, project, llmFn: badLlm });
  assert.strictEqual(res.enriched, 0);
  recs.forEach((r, i) => assert.strictEqual(r.donor_topic, before[i]));
});

// ── summary ──────────────────────────────────────────────────────────
(async () => {
  for (const { name, fn } of _queue) {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
  }
  console.log(`\nLink-strategy smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
