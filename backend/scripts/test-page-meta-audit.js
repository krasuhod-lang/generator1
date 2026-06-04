'use strict';

/**
 * Smoke-тест детерминированных хелперов постраничного аудита мета-тегов (п.4)
 * и общего staged-хелпера metaTags/metaStages. Без сети/LLM.
 * Запуск: node backend/scripts/test-page-meta-audit.js
 */

const assert = require('assert');
const {
  analyzeMetaLengths,
  selectPagesToAudit,
  buildSemanticsFromQueries,
  diffMeta,
} = require('../src/services/projects/pageMetaAudit');
const { _mergeSemantics } = require('../src/services/metaTags/metaStages');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

test('analyzeMetaLengths flags short/long/empty meta', () => {
  const r = analyzeMetaLengths({ title: '', description: 'x'.repeat(200), h1: 'Заголовок' });
  assert.ok(r.issues.includes('empty_title'));
  assert.ok(r.issues.includes('description_too_long'));
  assert.strictEqual(r.h1_len, 'Заголовок'.length);
});

test('analyzeMetaLengths detects h1 duplicates title', () => {
  const r = analyzeMetaLengths({ title: 'Купить насос', description: 'd'.repeat(150), h1: 'купить насос' });
  assert.ok(r.issues.includes('h1_duplicates_title'));
});

test('selectPagesToAudit prioritizes ctr anomalies and decay', () => {
  const snapshot = {
    commercial: {
      ctr_anomalies: [{ query: 'купить насос' }],
      intent_mismatch: [{ landing_page: 'https://x.ru/catalog/nasos' }],
    },
    page_decay: { items: [{ page: 'https://x.ru/blog/a', decaying: true }] },
    top_pages: [{ key: 'https://x.ru/top', impressions: 9000 }],
  };
  const queryPage = [{ query: 'купить насос', page: 'https://x.ru/p1', impressions: 500 }];
  const pages = selectPagesToAudit(snapshot, queryPage, { maxPages: 8 });
  const reasons = pages.map((p) => p.reason);
  assert.ok(reasons.includes('ctr_anomaly'));
  assert.ok(reasons.includes('page_decay'));
  assert.ok(reasons.includes('intent_mismatch'));
});

test('buildSemanticsFromQueries weights by impressions', () => {
  const sem = buildSemanticsFromQueries([
    { query: 'дренажный насос купить', impressions: 1000 },
    { query: 'насос для скважины', impressions: 50 },
  ]);
  assert.ok(sem.title_mandatory_words.includes('насос'));
  assert.ok(sem.title_mandatory_words.length <= 6);
  assert.ok(sem.description_mandatory_words.length <= 10);
});

test('diffMeta reports before/after lengths', () => {
  const d = diffMeta(
    { title: 'A', description: 'B', h1: 'C' },
    { title: 'AAA', description: 'BBBB', h1: 'CC' },
  );
  assert.strictEqual(d.title.before_len, 1);
  assert.strictEqual(d.title.after_len, 3);
  assert.strictEqual(d.description.after_len, 4);
});

test('metaStages._mergeSemantics keeps GSC words first, no dup, respects caps', () => {
  const merged = _mergeSemantics(
    { title_mandatory_words: ['насос'], description_mandatory_words: ['насос'] },
    { title_mandatory_words: ['насос', 'дренажный', 'скважина', 'погружной', 'фекальный', 'вибрационный', 'центробежный'],
      description_mandatory_words: ['насос', 'дренажный'] },
  );
  assert.strictEqual(merged.title_mandatory_words[0], 'насос'); // GSC-слово первым
  assert.ok(merged.title_mandatory_words.length <= 6);
  // нет дублей
  assert.strictEqual(new Set(merged.title_mandatory_words).size, merged.title_mandatory_words.length);
  assert.ok(merged.description_mandatory_words.includes('дренажный'));
});

console.log(`\nPage-meta-audit smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
