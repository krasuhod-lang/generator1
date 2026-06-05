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
  profileOverspam,
  aggregateOverspam,
  buildTopDifferential,
} = require('../src/services/projects/topPageInsights/contentProfiler');
const { selectComparisonPages } = require('../src/services/projects/topPageInsights');

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

test('explainRanking flags overspam risk', () => {
  const factors = explainRanking({
    position: 2, impressions: 900,
    profile: profileContent(sampleMd, 't'),
    overspam: { level: 'risk', overspam_score: 72 },
  });
  assert.ok(factors.some((f) => f.includes('переспам') || f.includes('КФ6')));
});

// ── profileOverspam (КФ6) ───────────────────────────────────────────
const overspamMd = (`# Купить пластиковые окна\n\n${Array.from({ length: 60 }, () => 'купить пластиковые окна недорого купить пластиковые окна в москве').join(' ')}`);

test('profileOverspam flags keyword stuffing as risk/watch', () => {
  const r = profileOverspam(overspamMd, 'Купить пластиковые окна купить окна', [
    { query: 'купить пластиковые окна' },
  ]);
  assert.ok(r.overspam_score > 0, `score ${r.overspam_score}`);
  assert.ok(['watch', 'risk'].includes(r.level), `level ${r.level}`);
  assert.ok(r.signals.length >= 1);
  assert.ok(Array.isArray(r.top_terms) && r.top_terms.length >= 1);
});

test('profileOverspam clean text → ok / unknown', () => {
  const r = profileOverspam(sampleMd, 'Как выбрать насос для скважины', [
    { query: 'насос для скважины' },
  ]);
  assert.ok(['ok', 'unknown', 'watch'].includes(r.level));
  assert.ok(r.overspam_score < 60);
});

test('profileOverspam too-short text → unknown', () => {
  const r = profileOverspam('короткий текст', 't', [{ query: 'текст' }]);
  assert.strictEqual(r.level, 'unknown');
  assert.strictEqual(r.overspam_score, 0);
});

// ── aggregateOverspam ───────────────────────────────────────────────
test('aggregateOverspam summarizes levels and risky pages', () => {
  const agg = aggregateOverspam([
    { url: 'a', overspam: { level: 'risk', overspam_score: 80, signals: ['x'] } },
    { url: 'b', overspam: { level: 'ok', overspam_score: 5, signals: [] } },
    { url: 'c', overspam: { level: 'watch', overspam_score: 40, signals: ['y'] } },
    { url: 'd', error: 'scrape_failed' },
    { url: 'e', overspam: { level: 'unknown', overspam_score: 0, signals: [] } },
  ]);
  assert.strictEqual(agg.pages_scored, 3);
  assert.strictEqual(agg.by_level.risk, 1);
  assert.strictEqual(agg.by_level.watch, 1);
  assert.strictEqual(agg.risky_pages.length, 2);
  // отсортировано по убыванию score
  assert.strictEqual(agg.risky_pages[0].url, 'a');
});

test('aggregateOverspam none scored → null', () => {
  assert.strictEqual(aggregateOverspam([{ url: 'x', error: 'e' }]), null);
  assert.strictEqual(aggregateOverspam([]), null);
});

// ── selectComparisonPages ───────────────────────────────────────────
test('selectComparisonPages picks laggards excluding top', () => {
  const cmpCfg = { minPosition: 11, maxPosition: 50, minImpressions: 50, maxPages: 3 };
  const sel = selectComparisonPages([
    { key: 'https://x.ru/top', impressions: 900, position: 2 },     // excluded by set
    { key: 'https://x.ru/lag1', impressions: 400, position: 15 },   // keep
    { key: 'https://x.ru/lag2', impressions: 200, position: 30 },   // keep
    { key: 'https://x.ru/lag3', impressions: 20, position: 20 },    // drop: low impr
    { key: 'https://x.ru/lag4', impressions: 800, position: 80 },   // drop: too far
  ], cmpCfg, new Set(['https://x.ru/top']));
  const urls = sel.map((p) => p.url);
  assert.deepStrictEqual(urls, ['https://x.ru/lag1', 'https://x.ru/lag2']);
});

// ── buildTopDifferential ────────────────────────────────────────────
test('buildTopDifferential surfaces what top has that rest lacks', () => {
  const richMd = (`${sampleMd}\n\n## Ещё\n${Array.from({ length: 300 }, () => 'слово').join(' ')}`);
  const top = [
    { profile: profileContent(richMd, 't'), coverage: { coverage_pct: 80 } },
    { profile: profileContent(richMd, 't'), coverage: { coverage_pct: 75 } },
  ];
  const rest = [
    { profile: profileContent('# Тонкая\n\nмало текста тут', 't'), coverage: { coverage_pct: 20 } },
    { profile: profileContent('# Тонкая 2\n\nещё мало', 't'), coverage: { coverage_pct: 25 } },
  ];
  const diff = buildTopDifferential(top, rest);
  assert.strictEqual(diff.available, true);
  assert.strictEqual(diff.top_count, 2);
  assert.strictEqual(diff.rest_count, 2);
  assert.ok(diff.advantages.length >= 1);
  assert.ok(diff.summary.length >= 1);
  // объём текста у топа должен быть преимуществом
  assert.ok(diff.advantages.some((a) => a.factor.includes('Объём')));
});

test('buildTopDifferential no comparison → available false', () => {
  const diff = buildTopDifferential([{ profile: profileContent(sampleMd, 't') }], []);
  assert.strictEqual(diff.available, false);
  assert.strictEqual(diff.reason, 'no_comparison');
});

// ── summary ──────────────────────────────────────────────────────────
console.log(`\nTop-page-insights smoke test: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
