'use strict';

/**
 * test-phase2-modules.js — combined tests for Phase 2 modules:
 *   • eeatChunker.js (Б1)
 *   • lsiPipeline.measureLsiCoverageSemantic (Б2)
 *   • validationFailures.service.js (С1)
 *   • eeatAudit/core.js — normalizeEeatAudit + chunked path (С2 + Б1)
 *
 * Запуск:  node backend/scripts/test-phase2-modules.js
 */

const assert = require('assert');
const path   = require('path');

const {
  splitByH2,
  chunkSections,
  chunkArticleForEeat,
  aggregateChunkAudits,
  buildLsiDigestByWeight,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'eeatChunker'));

const {
  measureLsiCoverageSemantic,
  measureLsiCoverageInHtml,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'lsiPipeline'));

const {
  createValidationTracker,
  classifyIssue,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'validationFailures.service'));

const {
  normalizeEeatAudit,
} = require(path.join(__dirname, '..', 'src', 'services', 'eeatAudit', 'core'));

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try {
    fn();
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
  }
}

// ── eeatChunker ──────────────────────────────────────────────────
console.log('\n=== eeatChunker ===');

check('splitByH2: no h2 → single chunk', () => {
  const r = splitByH2('<p>Hello world</p>');
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].h2_text, '');
});

check('splitByH2: 3 h2 → 3 sections', () => {
  const html = '<h2>One</h2><p>a</p><h2>Two</h2><p>b</p><h2>Three</h2><p>c</p>';
  const r = splitByH2(html);
  assert.strictEqual(r.length, 3);
  assert.strictEqual(r[0].h2_text, 'One');
  assert.strictEqual(r[2].h2_text, 'Three');
});

check('splitByH2: preamble before first h2 becomes [Введение]', () => {
  const intro = '<h1>Title</h1>' + '<p>This is a fairly long lead paragraph with enough text to count as introduction content.</p>';
  const html = intro + '<h2>S1</h2><p>x</p>';
  const r = splitByH2(html);
  assert.strictEqual(r.length, 2);
  assert.strictEqual(r[0].h2_text, '[Введение]');
});

check('chunkArticleForEeat: short article → 1 chunk', () => {
  const html = '<h2>One</h2><p>x</p>'.repeat(5);
  const r = chunkArticleForEeat(html);
  assert.strictEqual(r.length, 1);
});

check('chunkArticleForEeat: long article → multiple chunks', () => {
  // 12 sections, each ~2kb → ~24kb total, target ~8kb → ≥ 2 chunks
  const sections = [];
  for (let i = 0; i < 12; i += 1) {
    sections.push(`<h2>Section ${i + 1}</h2>` + '<p>Content paragraph here, decently sized text. </p>'.repeat(40));
  }
  const r = chunkArticleForEeat(sections.join(''));
  assert.ok(r.length >= 2, `expected >= 2 chunks, got ${r.length}`);
  for (const c of r) {
    assert.ok(c.html.length > 0);
    assert.ok(typeof c.index === 'number');
  }
});

check('chunkArticleForEeat: very long single section → split by </p>', () => {
  // single h2 with very long body
  const body = '<p>' + 'word '.repeat(2000) + '</p>'; // ~10kb
  const html = `<h2>Big</h2>${body.repeat(3)}`;
  const r = chunkArticleForEeat(html, { targetChars: 8000 });
  assert.ok(r.length >= 2, `expected >= 2 chunks, got ${r.length}`);
});

check('aggregateChunkAudits: weighted by char_count', () => {
  const cr = [
    { chunk: { index: 0, h2_text: 'A', char_count: 100 }, audit: { total_score: 8, verdict: 'pass', issues: [], lsi_coverage_pct: 80 } },
    { chunk: { index: 1, h2_text: 'B', char_count: 900 }, audit: { total_score: 5, verdict: 'refine', issues: ['x'], lsi_coverage_pct: 60 } },
  ];
  const a = aggregateChunkAudits(cr);
  // weighted = (8*100 + 5*900) / 1000 = 5.3
  assert.strictEqual(a.total_score, 5.3);
  assert.strictEqual(a.lsi_coverage_pct, 62);
  assert.strictEqual(a.issues.length, 1);
  assert.strictEqual(a.per_chunk.length, 2);
});

check('buildLsiDigestByWeight: respects budget', () => {
  const items = Array.from({ length: 30 }, (_, i) => ({ term: `term-${i}`, weight: 30 - i }));
  const out = buildLsiDigestByWeight(items, 200);
  assert.ok(out.length <= 200, `out=${out.length}`);
  const parsed = JSON.parse(out);
  // first term should be highest-weight one
  assert.strictEqual(parsed[0].term, 'term-0');
});

check('buildLsiDigestByWeight: handles {important:[...]}', () => {
  const out = buildLsiDigestByWeight({ important: [{ term: 'a', weight: 5 }, 'b'] }, 1000);
  const parsed = JSON.parse(out);
  assert.strictEqual(parsed.length, 2);
});

// ── LSI semantic coverage ──────────────────────────────────
console.log('\n=== LSI semantic coverage ===');

check('substring covers all → semantic_covered=0', () => {
  const html = '<p>Кошки и собаки часто играют вместе.</p>';
  const r = measureLsiCoverageSemantic(html, ['кошки', 'собаки']);
  assert.strictEqual(r.coveredCount, 2);
  assert.strictEqual(r.semantic_covered, 0);
});

check('semantic catches morphological variant via cosine', () => {
  // в тексте: «кошек» и «собак» (родительный мн.); LSI: «кошки», «собаки»
  // substring должен сработать на стеммах (кош-, собак-), но даже если
  // не сработает — семантический cosine подберёт.
  const html = '<p>Множество кошек и собак играют. ' .repeat(20) + '</p>';
  const r = measureLsiCoverageSemantic(html, ['кошки', 'собаки']);
  assert.ok(r.coveredCount >= 1);
});

check('completely missing term reports miss', () => {
  const html = '<p>Кошки и собаки.</p>';
  const r = measureLsiCoverageSemantic(html, ['квантовый компьютер']);
  assert.strictEqual(r.coveredCount, 0);
  assert.strictEqual(r.missing.length, 1);
});

check('empty inputs return empty report', () => {
  const r = measureLsiCoverageSemantic('', []);
  assert.strictEqual(r.coveredCount, 0);
  assert.strictEqual(r.totalCount, 0);
});

check('per_term has hit_kind for each term', () => {
  const html = '<p>Кошки играют. </p>'.repeat(20);
  const r = measureLsiCoverageSemantic(html, ['кошки', 'неведомое']);
  assert.strictEqual(r.per_term.length, 2);
  assert.ok(['substring', 'semantic', 'miss', 'skipped'].includes(r.per_term[0].hit_kind));
});

// ── Validation tracker ──────────────────────────────────
console.log('\n=== Validation tracker ===');

check('classifyIssue: faq pattern', () => {
  assert.strictEqual(classifyIssue('Не хватает <h2>FAQ</h2> блока'), 'faq_block');
});

check('classifyIssue: link coverage', () => {
  assert.strictEqual(classifyIssue('Низкое покрытие плана ссылок (50%)'), 'link_coverage');
});

check('classifyIssue: unknown → other', () => {
  assert.strictEqual(classifyIssue('Some random unknown issue text'), 'other');
});

check('createValidationTracker: tracks initial+refine, computes diff', () => {
  const t = createValidationTracker();
  t.recordPass('writer_initial', ['Не хватает <h2>FAQ</h2>', 'Низкое покрытие плана ссылок']);
  t.recordPass('writer_refine', ['Низкое покрытие плана ссылок']);
  const r = t.toReport();
  assert.strictEqual(r.total_passes, 2);
  assert.strictEqual(r.initial_count, 2);
  assert.strictEqual(r.final_count, 1);
  assert.ok(r.fixed_kinds.includes('faq_block'));
  assert.ok(r.persistent_kinds.includes('link_coverage'));
});

check('createValidationTracker: empty input returns zero report', () => {
  const t = createValidationTracker();
  const r = t.toReport();
  assert.strictEqual(r.total_passes, 0);
  assert.strictEqual(r.final_count, 0);
});

// ── normalizeEeatAudit ──────────────────────────────────
console.log('\n=== eeatAudit/core normalize ===');

check('normalizeEeatAudit: clamps total_score', () => {
  const r = normalizeEeatAudit({ total_score: 25 }, 7.5);
  assert.strictEqual(r.total_score, 10);
});

check('normalizeEeatAudit: invalid score → 0', () => {
  const r = normalizeEeatAudit({ total_score: 'foo' }, 7.5);
  assert.strictEqual(r.total_score, 0);
});

check('normalizeEeatAudit: missing verdict → derives from threshold', () => {
  const a = normalizeEeatAudit({ total_score: 8.0 }, 7.5);
  assert.strictEqual(a.verdict, 'pass');
  const b = normalizeEeatAudit({ total_score: 5.0 }, 7.5);
  assert.strictEqual(b.verdict, 'refine');
});

check('normalizeEeatAudit: invalid verdict → derives', () => {
  const a = normalizeEeatAudit({ total_score: 8.0, verdict: 'WAT' }, 7.5);
  assert.strictEqual(a.verdict, 'pass');
});

check('normalizeEeatAudit: respects valid verdict', () => {
  const a = normalizeEeatAudit({ total_score: 8.0, verdict: 'reject' }, 7.5);
  assert.strictEqual(a.verdict, 'reject');
});

check('normalizeEeatAudit: ensures issues is array', () => {
  const a = normalizeEeatAudit({ total_score: 5, issues: null }, 7.5);
  assert.ok(Array.isArray(a.issues));
});

// ── Summary ──────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
if (_pass === _cases) {
  console.log(`✅ All ${_cases} Phase 2 modules tests passed`);
  process.exit(0);
} else {
  console.log(`❌ ${_pass}/${_cases} passed`);
  process.exit(1);
}
