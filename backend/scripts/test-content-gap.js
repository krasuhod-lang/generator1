'use strict';

/**
 * Smoke-тест контент-плана блога (п.3 ТЗ). Детерминированный, без сети/LLM.
 * Запуск: node backend/scripts/test-content-gap.js
 */

const assert = require('assert');
const { detectGaps, _isInfo } = require('../src/services/projects/contentGapPlanner/gapDetector');
const { generateTopics, buildTopicFromGap, TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX } = require('../src/services/projects/contentGapPlanner/topicGenerator');
const { buildBlogPlan } = require('../src/services/projects/contentGapPlanner');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const topQueries = [
  { key: 'как выбрать насос', position: 12, impressions: 500 },
  { key: 'купить насос', position: 6, impressions: 800 },
  { key: 'что такое дренажный насос', position: 9, impressions: 200 },
];
const queryPage = [{ query: 'как установить насос', page: 'https://x.ru/catalog/nasos', impressions: 120, position: 14 }];
const breakdowns = { country: [{ key: 'rus', impressions: 5000 }, { key: 'kaz', impressions: 300 }] };

test('_isInfo classifies informational queries', () => {
  assert.strictEqual(_isInfo('как выбрать насос', []), true);
  assert.strictEqual(_isInfo('купить насос', []), false);
});

test('detectGaps finds striking-info and mismatch gaps', () => {
  const { gaps, signals } = detectGaps({ topQueries, queryPage, breakdowns, brandTokens: [] });
  assert.ok(gaps.some((g) => g.reason === 'striking_info'));
  assert.ok(gaps.some((g) => g.reason === 'info_query_on_commerce_page'));
  assert.ok(signals.geo.length >= 1);
});

test('buildTopicFromGap respects title/description length limits', () => {
  const t = buildTopicFromGap({ query: 'как выбрать насос', impressions: 500, position: 12 }, { name: 'AquaShop' });
  assert.ok(t.title.length >= TITLE_MIN && t.title.length <= TITLE_MAX, `title len ${t.title.length}`);
  assert.ok(t.description.length >= DESC_MIN && t.description.length <= DESC_MAX, `desc len ${t.description.length}`);
  assert.ok(t.supporting_queries.length >= 1);
  // Факт-обоснование: интент размечен, evidence несёт реальные цифры.
  assert.ok(typeof t.intent === 'string' && t.intent.length > 0);
  assert.ok(Array.isArray(t.evidence) && t.evidence[0].impressions === 500);
  assert.ok(typeof t.intent_gap === 'string' && t.intent_gap.length > 0);
});

async function asyncBlock() {
  // generateTopics builds only fact-based topics (every topic has supporting query)
  {
    const { gaps } = detectGaps({ topQueries, queryPage, breakdowns, brandTokens: [] });
    const res = await generateTopics({ gaps, project: { name: 'AquaShop' } });
    assert.ok(res.topics.length >= 1, `got ${res.topics.length}`);
    assert.strictEqual(res.topics.length, gaps.length, 'topic per gap, no synthetic backfill');
    res.topics.forEach((t) => {
      assert.ok(t.title.length <= TITLE_MAX);
      assert.ok(t.description.length <= DESC_MAX);
      // Каждая тема привязана к реальному запросу со статистикой (без галлюцинаций).
      assert.ok(t.supporting_queries.length >= 1 && t.supporting_queries[0]);
      assert.ok(Array.isArray(t.evidence) && t.evidence.length >= 1);
    });
    passed += 1; console.log('  ✓ generateTopics returns one fact-based topic per gap');
  }
  // insufficient flag set when gaps < minTopics
  {
    const res = await generateTopics({ gaps: [{ query: 'как выбрать насос', reason: 'striking_info', impressions: 500, position: 12 }], project: { name: 'AquaShop' } });
    assert.ok(res.insufficient && res.insufficient.got === 1 && res.insufficient.needed === 5);
    passed += 1; console.log('  ✓ generateTopics flags insufficient data instead of fake topics');
  }
  // empty gaps → no topics, no crash
  {
    const res = await generateTopics({ gaps: [], project: { name: 'AquaShop' } });
    assert.strictEqual(res.topics.length, 0);
    assert.ok(res.insufficient);
    passed += 1; console.log('  ✓ generateTopics returns no topics when there are no gaps');
  }
  // buildBlogPlan end-to-end deterministic
  {
    const plan = await buildBlogPlan({ project: { name: 'AquaShop' }, topQueries, queryPage, breakdowns, brandTokens: [] });
    assert.strictEqual(plan.available, true);
    assert.ok(plan.topics_count >= 1);
    passed += 1; console.log('  ✓ buildBlogPlan produces fact-based topics');
  }
  // LLM path graceful fallback on bad JSON
  {
    const { gaps } = detectGaps({ topQueries, queryPage, breakdowns, brandTokens: [] });
    const res = await generateTopics({ gaps, project: { name: 'AquaShop' }, llmFn: async () => 'not a json' });
    assert.ok(res.topics.length >= 1);
    passed += 1; console.log('  ✓ generateTopics falls back when LLM returns invalid JSON');
  }
  // LLM hallucination guard: topic referencing a query NOT in the input set is dropped
  {
    const { gaps } = detectGaps({ topQueries, queryPage, breakdowns, brandTokens: [] });
    const fakeJson = JSON.stringify([
      { topic: 'Выдуманная тема', title: 'x'.repeat(55), description: 'y'.repeat(150), supporting_queries: ['несуществующий запрос про космос'] },
    ]);
    const res = await generateTopics({ gaps, project: { name: 'AquaShop' }, llmFn: async () => fakeJson });
    // Привязка по индексу спасает (baseTopic = base[0]), но supporting_queries остаются из базы.
    res.topics.forEach((t) => {
      assert.ok(t.supporting_queries[0] !== 'несуществующий запрос про космос',
        'hallucinated query must not leak into supporting_queries');
    });
    passed += 1; console.log('  ✓ generateTopics keeps supporting_queries factual under LLM hallucination');
  }

  // ── Анти-дубли: тема, уже закрытая страницей сайта, не идёт в новые статьи ──
  {
    // Запрос приземляется на статью блога → тема уже есть на сайте.
    const qp = [{ query: 'как выбрать насос', page: 'https://x.ru/blog/kak-vybrat-nasos', impressions: 300, position: 11 }];
    const { gaps, covered } = detectGaps({ topQueries, queryPage: qp, breakdowns, brandTokens: [] });
    assert.ok(!gaps.some((g) => g.query === 'как выбрать насос'), 'covered topic must not be a gap');
    const c = covered.find((x) => x.query === 'как выбрать насос');
    assert.ok(c, 'covered list must contain the topic');
    assert.strictEqual(c.match, 'landing');
    assert.strictEqual(c.existing_url, 'https://x.ru/blog/kak-vybrat-nasos');
    passed += 1; console.log('  ✓ detectGaps drops topics already covered by a landing blog page');
  }
  // Дубль по заголовку существующей статьи (title из аудита мета-тегов).
  {
    const pageMetaAudit = {
      pages: [{ url: 'https://x.ru/blog/vybor-nasosa', before: { title: 'Как выбрать насос: подробный гид', h1: 'Как выбрать насос' } }],
    };
    const { gaps, covered } = detectGaps({
      topQueries, queryPage: [], breakdowns, brandTokens: [], pageMetaAudit,
    });
    assert.ok(!gaps.some((g) => g.query === 'как выбрать насос'), 'similar existing article must block the topic');
    assert.ok(covered.some((x) => x.match === 'similar' && x.existing_url === 'https://x.ru/blog/vybor-nasosa'));
    passed += 1; console.log('  ✓ detectGaps drops topics duplicating an existing article title');
  }
  // Коммерческая страница НЕ закрывает информационную тему.
  {
    const qp = [{ query: 'как выбрать насос', page: 'https://x.ru/catalog/nasosy', impressions: 300, position: 11 }];
    const { gaps } = detectGaps({ topQueries, queryPage: qp, breakdowns, brandTokens: [] });
    assert.ok(gaps.some((g) => g.query === 'как выбрать насос'), 'commerce landing must not cover an info topic');
    passed += 1; console.log('  ✓ commerce landing page does not count as existing coverage');
  }
  // Дедуп тем между собой: две «дыры» об одном и том же → одна тема.
  {
    const gaps = [
      { query: 'как выбрать насос', reason: 'striking_info', impressions: 500, position: 12 },
      { query: 'как выбрать насос для дачи', reason: 'striking_info', impressions: 120, position: 15 },
      { query: 'что такое дренажный насос', reason: 'striking_info', impressions: 200, position: 9 },
    ];
    const res = await generateTopics({ gaps, project: { name: 'AquaShop' } });
    assert.strictEqual(res.topics.length, 2, `expected 2 unique topics, got ${res.topics.length}`);
    const main = res.topics.find((t) => t.supporting_queries.includes('как выбрать насос'));
    assert.ok(main && main.supporting_queries.includes('как выбрать насос для дачи'), 'duplicate query merged into supporting_queries');
    assert.strictEqual(res.merged_duplicates.length, 1);
    passed += 1; console.log('  ✓ generateTopics merges duplicate topics instead of publishing both');
  }
  // buildBlogPlan прокидывает already_covered наружу.
  {
    const qp = [{ query: 'как выбрать насос', page: 'https://x.ru/blog/kak-vybrat-nasos', impressions: 300, position: 11 }];
    const plan = await buildBlogPlan({ project: { name: 'AquaShop' }, topQueries, queryPage: qp, breakdowns, brandTokens: [] });
    assert.strictEqual(plan.available, true);
    assert.ok(plan.already_covered_count >= 1);
    assert.ok(!plan.topics.some((t) => t.supporting_queries.includes('как выбрать насос')));
    passed += 1; console.log('  ✓ buildBlogPlan exposes already_covered and skips duplicate topics');
  }
}

(async () => {
  await asyncBlock();
  console.log(`\nContent-gap smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
