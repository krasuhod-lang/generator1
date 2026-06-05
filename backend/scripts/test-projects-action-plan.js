'use strict';

/**
 * Smoke-тест «Плана действий» проекта (ТЗ п.3). Детерминированный, без сети/LLM.
 * Запуск: node backend/scripts/test-projects-action-plan.js
 */

const assert = require('assert');
const {
  ctrForPosition,
  expectedExtraClicks,
  selectMetaTargets,
  buildMetaChanges,
  buildStrikingDistance,
  buildContentRefresh,
  buildCannibalization,
  buildArticleTopics,
  summarize,
} = require('../src/services/projects/actionPlan');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const benchmark = {
  1: 0.28, 2: 0.16, 3: 0.11, 4: 0.08, 5: 0.06,
  6: 0.045, 7: 0.035, 8: 0.03, 9: 0.025, 10: 0.022,
};
const cfg = {
  enabled: true, maxMetaTargets: 6, autoMeta: true, maxStrikingDistance: 15,
  targetPosition: 3, maxContentRefresh: 10, maxArticleTopics: 10,
  minImpressions: 30, tailCtr: 0.01,
};

// ── ctrForPosition ──────────────────────────────────────────────────
test('ctrForPosition exact positions from benchmark', () => {
  assert.strictEqual(ctrForPosition(1, benchmark), 0.28);
  assert.strictEqual(ctrForPosition(3, benchmark), 0.11);
});

test('ctrForPosition interpolates fractional positions', () => {
  const v = ctrForPosition(4.5, benchmark); // между 0.08 и 0.06
  assert.ok(v < 0.08 && v > 0.06, `expected between 0.06 and 0.08, got ${v}`);
});

test('ctrForPosition uses tailCtr beyond table', () => {
  assert.strictEqual(ctrForPosition(25, benchmark, 0.01), 0.01);
});

test('ctrForPosition guards bad input', () => {
  assert.strictEqual(ctrForPosition(0, benchmark), 0);
  assert.strictEqual(ctrForPosition(-3, benchmark), 0);
  assert.strictEqual(ctrForPosition('x', benchmark), 0);
});

// ── expectedExtraClicks ─────────────────────────────────────────────
test('expectedExtraClicks computes uplift to target position', () => {
  // позиция 8 (эталон 3%), цель 3 (11%), 1000 показов → ~ (0.11-0.03)*1000 = 80
  const r = expectedExtraClicks({
    impressions: 1000, currentCtrPct: 3, position: 8, targetPosition: 3, benchmark, tailCtr: 0.01,
  });
  assert.strictEqual(r.extra_clicks, 80);
  assert.strictEqual(r.target_ctr_pct, 11);
});

test('expectedExtraClicks never negative when already above target', () => {
  const r = expectedExtraClicks({
    impressions: 1000, currentCtrPct: 30, position: 2, targetPosition: 3, benchmark,
  });
  assert.strictEqual(r.extra_clicks, 0);
});

test('expectedExtraClicks falls back to benchmark CTR when factual missing', () => {
  const r = expectedExtraClicks({
    impressions: 500, position: 10, targetPosition: 3, benchmark, tailCtr: 0.01,
  });
  // (0.11 - 0.022) * 500 = 44
  assert.strictEqual(r.extra_clicks, 44);
});

// ── selectMetaTargets ───────────────────────────────────────────────
const pma = {
  available: true,
  pages: [
    { url: 'https://x.ru/top', reason: 'top_impressions', before: { title: 't' }, queries: [{ query: 'a' }], lengths: { issues: [] } },
    { url: 'https://x.ru/ctr', reason: 'ctr_anomaly', before: { title: 't2' }, queries: [{ query: 'kupit divan' }], lengths: { issues: ['title_too_short'] } },
    { url: 'https://x.ru/decay', reason: 'page_decay', before: { title: 't3' }, queries: [{ query: 'c' }], lengths: { issues: [] } },
    { url: 'https://x.ru/broken', reason: 'ctr_anomaly', error: 'scrape_failed' },
    { url: 'https://x.ru/noq', reason: 'page_decay', before: { title: 't4' }, queries: [] },
  ],
};

test('selectMetaTargets prioritizes by reason and drops unusable', () => {
  const sel = selectMetaTargets(pma, 6);
  const urls = sel.map((p) => p.url);
  assert.deepStrictEqual(urls, ['https://x.ru/ctr', 'https://x.ru/decay', 'https://x.ru/top']);
});

test('selectMetaTargets respects max', () => {
  assert.strictEqual(selectMetaTargets(pma, 1).length, 1);
  assert.strictEqual(selectMetaTargets(pma, 0).length, 0);
});

test('selectMetaTargets handles empty', () => {
  assert.deepStrictEqual(selectMetaTargets(null, 5), []);
  assert.deepStrictEqual(selectMetaTargets({ pages: [] }, 5), []);
});

// ── buildMetaChanges ────────────────────────────────────────────────
test('buildMetaChanges merges suggested + computes ctr undershoot', () => {
  const commercial = {
    ctr_anomalies: [{ query: 'kupit divan', ctr: 1, expectedCtr: 8, position: 4, impressions: 1000 }],
  };
  const suggestedByUrl = { 'https://x.ru/ctr': { title: 'NEW', description: 'D', h1: 'H' } };
  const changes = buildMetaChanges({ pageMetaAudit: pma, commercial, suggestedByUrl, benchmark, cfg });
  const ctrItem = changes.find((c) => c.url === 'https://x.ru/ctr');
  assert.ok(ctrItem, 'ctr item present');
  assert.strictEqual(ctrItem.suggested.title, 'NEW');
  assert.ok(ctrItem.expected_effect && ctrItem.expected_effect.extra_clicks > 0, 'undershoot computed');
  assert.ok(/недобор/.test(ctrItem.why), 'why mentions недобор');
});

test('buildMetaChanges works without suggested (graceful, no keys)', () => {
  const changes = buildMetaChanges({ pageMetaAudit: pma, commercial: {}, suggestedByUrl: {}, benchmark, cfg });
  assert.ok(changes.length > 0);
  assert.strictEqual(changes[0].suggested, null);
  assert.ok(changes[0].why.length > 0);
});

// ── buildStrikingDistance ───────────────────────────────────────────
test('buildStrikingDistance computes expected clicks and sorts desc', () => {
  const commercial = {
    striking_distance: [
      { query: 'a', intent: 'commercial', impressions: 2000, ctr: 1, position: 7 },
      { query: 'b', intent: 'commercial', impressions: 100, ctr: 1, position: 6 },
      { query: 'c', intent: 'commercial', impressions: 10, ctr: 1, position: 5 }, // отсев по minImpressions
    ],
  };
  const queryPage = [{ query: 'a', page: 'https://x.ru/a', impressions: 2000 }];
  const sd = buildStrikingDistance({ commercial, benchmark, cfg, queryPage });
  assert.strictEqual(sd.length, 2);
  assert.strictEqual(sd[0].query, 'a');
  assert.ok(sd[0].expected_extra_clicks >= sd[1].expected_extra_clicks);
  assert.strictEqual(sd[0].page, 'https://x.ru/a');
  assert.ok(/\+\d+ кликов/.test(sd[0].why));
});

// ── buildContentRefresh ─────────────────────────────────────────────
test('buildContentRefresh keeps only decaying pages', () => {
  const pageDecay = {
    items: [
      { page: 'https://x.ru/d1', decaying: true, weeks: 8, mean_weekly_clicks: 40, slope_norm: -0.12, total_clicks: 300 },
      { page: 'https://x.ru/ok', decaying: false, weeks: 8, mean_weekly_clicks: 50, slope_norm: 0.01 },
    ],
  };
  const cr = buildContentRefresh({ pageDecay, cfg });
  assert.strictEqual(cr.length, 1);
  assert.strictEqual(cr[0].url, 'https://x.ru/d1');
  assert.strictEqual(cr[0].slope_pct_per_week, -12);
  assert.ok(cr[0].expected_effect.restore_weekly_clicks === 40);
});

// ── buildCannibalization ────────────────────────────────────────────
test('buildCannibalization maps verdicts to concrete actions', () => {
  const commercial = {
    cannibalization: [{ query: 'kupit', intent: 'commercial', best_position: 6, pages: [{ page: 'a' }, { page: 'b' }] }],
  };
  const serpVerification = { items: [{ query: 'kupit', verdict: 'merge_recommended' }] };
  const c = buildCannibalization({ commercial, serpVerification });
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].verdict, 'merge_recommended');
  assert.ok(/301/.test(c[0].action));
});

test('buildCannibalization defaults to inconclusive verdict', () => {
  const commercial = { cannibalization: [{ query: 'x', best_position: 5, pages: [{ page: 'a' }, { page: 'b' }] }] };
  const c = buildCannibalization({ commercial, serpVerification: null });
  assert.strictEqual(c[0].verdict, 'inconclusive');
});

// ── buildArticleTopics ──────────────────────────────────────────────
test('buildArticleTopics surfaces concrete titles + evidence', () => {
  const blogPlan = {
    topics: [{
      title: 'Как выбрать диван: гид', h1: 'Как выбрать диван', description: 'desc',
      intent: 'informational', intent_gap: 'Не закрыт информационный интент',
      supporting_queries: ['как выбрать диван'], evidence: [{ query: 'как выбрать диван', impressions: 500 }],
    }],
  };
  const topPageInsights = { recommendations: ['Добавлять FAQ-блок'] };
  const topics = buildArticleTopics({ blogPlan, topPageInsights, cfg });
  assert.ok(topics.length >= 2);
  assert.strictEqual(topics[0].title, 'Как выбрать диван: гид');
  assert.strictEqual(topics[0].expected_effect.impressions_in_demand, 500);
  assert.ok(topics.some((t) => t.source === 'top_page_pattern'));
});

// ── summarize ───────────────────────────────────────────────────────
test('summarize aggregates iron-clad potential numbers', () => {
  const s = summarize({
    metaChanges: [{ expected_effect: { extra_clicks: 30 } }],
    strikingDistance: [{ expected_extra_clicks: 80 }, { expected_extra_clicks: 20 }],
    contentRefresh: [{ expected_effect: { restore_weekly_clicks: 40 } }],
    cannibalization: [{}],
    articleTopics: [{ title: 'T' }, { recommendation: 'R' }],
  });
  assert.strictEqual(s.est_extra_clicks, 130); // 30 + 80 + 20
  assert.strictEqual(s.est_recoverable_weekly_clicks, 40);
  assert.strictEqual(s.article_topics_count, 1); // только с title
  assert.strictEqual(s.striking_distance_count, 2);
});

console.log(`\nAction-plan smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
