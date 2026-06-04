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
  const t = buildTopicFromGap({ query: 'как выбрать насос' }, { name: 'AquaShop' });
  assert.ok(t.title.length >= TITLE_MIN && t.title.length <= TITLE_MAX, `title len ${t.title.length}`);
  assert.ok(t.description.length >= DESC_MIN && t.description.length <= DESC_MAX, `desc len ${t.description.length}`);
  assert.ok(t.supporting_queries.length >= 1);
});

async function asyncBlock() {
  // generateTopics always >= minTopics (5)
  {
    const { gaps } = detectGaps({ topQueries, queryPage, breakdowns, brandTokens: [] });
    const res = await generateTopics({ gaps, project: { name: 'AquaShop' } });
    assert.ok(res.topics.length >= 5, `got ${res.topics.length}`);
    res.topics.forEach((t) => {
      assert.ok(t.title.length <= TITLE_MAX);
      assert.ok(t.description.length <= DESC_MAX);
    });
    passed += 1; console.log('  ✓ generateTopics returns >= 5 valid topics');
  }
  // buildBlogPlan end-to-end deterministic
  {
    const plan = await buildBlogPlan({ project: { name: 'AquaShop' }, topQueries, queryPage, breakdowns, brandTokens: [] });
    assert.strictEqual(plan.available, true);
    assert.ok(plan.topics_count >= 5);
    passed += 1; console.log('  ✓ buildBlogPlan produces >= 5 topics');
  }
  // LLM path graceful fallback on bad JSON
  {
    const { gaps } = detectGaps({ topQueries, queryPage, breakdowns, brandTokens: [] });
    const res = await generateTopics({ gaps, project: { name: 'AquaShop' }, llmFn: async () => 'not a json' });
    assert.ok(res.topics.length >= 5);
    passed += 1; console.log('  ✓ generateTopics falls back when LLM returns invalid JSON');
  }
}

(async () => {
  await asyncBlock();
  console.log(`\nContent-gap smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
