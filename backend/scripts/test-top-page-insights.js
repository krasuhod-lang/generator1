'use strict';

/**
 * Smoke-тест реверс-инжиниринга топовых страниц (п.3 ТЗ).
 * Детерминированный, без сети/LLM.
 * Запуск: node backend/scripts/test-top-page-insights.js
 */

const assert = require('assert');
const {
  selectTopPages,
  profileContent,
  computeQueryCoverage,
  aggregatePatterns,
  buildRecommendations,
  explainRanking,
} = require('../src/services/projects/topPageInsights/contentProfiler');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

const cfg = { minImpressions: 100, maxPosition: 10, maxPages: 6, minRecommendations: 5 };

// ── selectTopPages ──────────────────────────────────────────────────
test('selectTopPages keeps high-impression high-position pages, drops low', () => {
  const sel = selectTopPages([
    { key: 'https://x.ru/a', impressions: 900, position: 2.1 },   // keep
    { key: 'https://x.ru/b', impressions: 500, position: 9.8 },   // keep
    { key: 'https://x.ru/c', impressions: 50, position: 1.0 },    // drop: low impressions
    { key: 'https://x.ru/d', impressions: 800, position: 25.0 },  // drop: bad position
    { key: 'https://x.ru/e', impressions: 300, position: 0 },     // drop: no position
  ], cfg);
  const urls = sel.map((p) => p.url);
  assert.deepStrictEqual(urls, ['https://x.ru/a', 'https://x.ru/b']);
  // отсортировано по показам убыв.
  assert.strictEqual(sel[0].impressions, 900);
});

test('selectTopPages respects maxPages', () => {
  const pages = Array.from({ length: 10 }, (_, i) => ({ key: `https://x.ru/${i}`, impressions: 1000 - i, position: 3 }));
  const sel = selectTopPages(pages, { ...cfg, maxPages: 3 });
  assert.strictEqual(sel.length, 3);
});

test('selectTopPages empty input → []', () => {
  assert.deepStrictEqual(selectTopPages([], cfg), []);
  assert.deepStrictEqual(selectTopPages(null, cfg), []);
});

// ── profileContent ──────────────────────────────────────────────────
const sampleMd = `# Как выбрать насос для скважины

Вступительный абзац про выбор насоса для скважины и его параметры подбора оборудования.

## Типы насосов

- Погружные насосы
- Поверхностные насосы
- Вихревые модели

## Сравнение по цене

| Модель | Цена |
| --- | --- |
| A | 1000 |

![схема](https://x.ru/img.png)

### Подраздел

Текст подраздела со ссылкой [тут](https://x.ru/page).`;

test('profileContent extracts structure deterministically', () => {
  const p = profileContent(sampleMd, 'Как выбрать насос для скважины');
  assert.strictEqual(p.h1_count, 1);
  assert.strictEqual(p.h2_count, 2);
  assert.strictEqual(p.h3_count, 1);
  assert.strictEqual(p.has_lists, true);
  assert.strictEqual(p.has_tables, true);
  assert.strictEqual(p.image_count, 1);
  assert.ok(p.link_count >= 1);
  assert.ok(p.intro_words > 0);
  assert.ok(p.word_count > 10);
});

test('profileContent handles empty markdown', () => {
  const p = profileContent('', '');
  assert.strictEqual(p.word_count, 0);
  assert.strictEqual(p.h2_count, 0);
  assert.strictEqual(p.has_lists, false);
});

// ── computeQueryCoverage ────────────────────────────────────────────
test('computeQueryCoverage scores presence of query words in content', () => {
  const cov = computeQueryCoverage(sampleMd, [
    { query: 'насос для скважины' },
    { query: 'купить вертолёт' },
  ]);
  assert.ok(cov.coverage_pct > 0 && cov.coverage_pct <= 100);
  assert.ok(cov.covered.length >= 1);
  // "вертолёт" отсутствует в тексте
  assert.ok(cov.missing.some((w) => w.includes('вертол')));
});

test('computeQueryCoverage empty queries → 0', () => {
  const cov = computeQueryCoverage(sampleMd, []);
  assert.strictEqual(cov.coverage_pct, 0);
});

// ── aggregatePatterns + buildRecommendations ────────────────────────
const profiledPages = [
  { position: 2, profile: profileContent(sampleMd, 't'), coverage: { coverage_pct: 70 } },
  { position: 4, profile: profileContent(sampleMd + '\n\n## Ещё раздел\nтекст', 't'), coverage: { coverage_pct: 50 } },
  { url: 'x', error: 'scrape_failed' },
];

test('aggregatePatterns ignores failed pages and computes stats', () => {
  const pat = aggregatePatterns(profiledPages);
  assert.strictEqual(pat.pages_analyzed, 2);
  assert.ok(pat.median_word_count > 0);
  assert.ok(pat.median_h2_count >= 2);
  assert.ok(pat.pct_with_lists >= 50);
  assert.ok(pat.pct_with_tables >= 40);
  assert.ok(pat.median_position >= 2);
});

test('aggregatePatterns all-failed → null', () => {
  assert.strictEqual(aggregatePatterns([{ error: 'x' }]), null);
  assert.strictEqual(aggregatePatterns([]), null);
});

test('buildRecommendations always returns >= minRecommendations', () => {
  const pat = aggregatePatterns(profiledPages);
  const recs = buildRecommendations(pat, cfg);
  assert.ok(recs.length >= 5, `got ${recs.length}`);
  recs.forEach((r) => assert.ok(typeof r === 'string' && r.length > 0));
});

test('buildRecommendations >= min even with null patterns', () => {
  const recs = buildRecommendations(null, cfg);
  assert.ok(recs.length >= 5);
});

// ── explainRanking ──────────────────────────────────────────────────
test('explainRanking produces deterministic factors', () => {
  const factors = explainRanking({
    position: 2, impressions: 900,
    profile: profileContent(sampleMd, 't'),
    coverage: { coverage_pct: 70 },
  });
  assert.ok(factors.length >= 1);
  assert.ok(factors.some((f) => f.includes('позиция') || f.includes('покрытие') || f.includes('структура')));
});

test('explainRanking no profile → []', () => {
  assert.deepStrictEqual(explainRanking({ position: 2 }), []);
});

// ── summary ──────────────────────────────────────────────────────────
console.log(`\nTop-page-insights smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
