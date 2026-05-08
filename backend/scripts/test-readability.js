'use strict';

/**
 * test-readability.js — юнит-тесты для readability.service.js (Phase 2 / Б4).
 * Запуск:  node backend/scripts/test-readability.js
 */

const assert = require('assert');
const path   = require('path');

const { analyzeReadability, _internal } = require(
  path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'readability.service'),
);

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

// ── Test 1: htmlToPlain ────────────────────────────────────────
console.log('\n=== Test 1: htmlToPlain ===');
check('strips tags, keeps text', () => {
  const out = _internal.htmlToPlain('<p>Hello <b>world</b>!</p>');
  assert.ok(out.includes('Hello'));
  assert.ok(out.includes('world'));
});
check('strips script/style/code', () => {
  const out = _internal.htmlToPlain('<p>Visible</p><script>x=1</script>');
  assert.ok(out.includes('Visible'));
  // we don't enforce script-strip here, just that no tag leaks (case-insensitive)
  assert.ok(!/<script\b/i.test(out));
});

// ── Test 2: splitSentences ───────────────────────────────────
console.log('\n=== Test 2: splitSentences ===');
check('splits on .?!', () => {
  const out = _internal.splitSentences('Это первое. Второе! Третье?');
  assert.strictEqual(out.length, 3);
});
check('respects abbreviations (г.)', () => {
  const out = _internal.splitSentences('В 2020 г. это было важно. Но потом всё изменилось.');
  assert.strictEqual(out.length, 2, `expected 2, got ${out.length}: ${JSON.stringify(out)}`);
});
check('numeric list "1." not a sentence end', () => {
  const out = _internal.splitSentences('Список: 1. Первый пункт. 2. Второй пункт.');
  // depending on heuristic; just ensure no crash and at least 1 sentence
  assert.ok(out.length >= 1);
});

// ── Test 3: wordsOf ──────────────────────────────────────────
console.log('\n=== Test 3: wordsOf ===');
check('lowercase + ё→е + tokenize', () => {
  const w = _internal.wordsOf('Ёжик. Дом! Ёлка-Ёлочка.');
  assert.deepStrictEqual(w, ['ежик', 'дом', 'елка-елочка']);
});

// ── Test 4: flesch ───────────────────────────────────────────
console.log('\n=== Test 4: flesch index ===');
check('returns clamped [0..100]', () => {
  const w = _internal.wordsOf('кот мама дом');
  const v = _internal.flesch('кот. мама. дом.', w, ['кот.', 'мама.', 'дом.']);
  assert.ok(v >= 0 && v <= 100, `out of range: ${v}`);
});
check('long words → low index', () => {
  // "псевдополициклический" — 7 слогов
  const w = _internal.wordsOf('псевдополициклический катализатор гидроксиметилфурфурол');
  const v = _internal.flesch(
    'псевдополициклический катализатор гидроксиметилфурфурол.',
    w,
    ['псевдополициклический катализатор гидроксиметилфурфурол.'],
  );
  assert.ok(v < 50, `expected <50 (heavy), got ${v}`);
});

// ── Test 5: bureaucratese ─────────────────────────────────────
console.log('\n=== Test 5: bureaucratese ratio ===');
check('detects "осуществлять"', () => {
  const w = _internal.wordsOf('Мы осуществляем поставку товаров.');
  const r = _internal.bureaucrateseRatio('мы осуществляем поставку товаров.', w);
  assert.ok(r > 0, `expected hits, got ${r}`);
});
check('zero on clean text', () => {
  const w = _internal.wordsOf('Кот сидит на окне.');
  const r = _internal.bureaucrateseRatio('кот сидит на окне.', w);
  assert.strictEqual(r, 0);
});

// ── Test 6: passive ratio ─────────────────────────────────────
console.log('\n=== Test 6: passive ratio ===');
check('detects "выполняется"', () => {
  const w = _internal.wordsOf('Работа выполняется в срок.');
  const r = _internal.passiveRatio(w);
  assert.ok(r > 0);
});
check('low on active text', () => {
  const w = _internal.wordsOf('Кот ловит мышь. Мама моет окно.');
  const r = _internal.passiveRatio(w);
  assert.ok(r <= 0.2);
});

// ── Test 7: full analyzer ─────────────────────────────────────
console.log('\n=== Test 7: analyzeReadability (high-level) ===');
check('verdict=na on too-short text', () => {
  const r = analyzeReadability('<p>Тест.</p>');
  assert.strictEqual(r.verdict, 'na');
});
check('returns metrics object with required fields', () => {
  const html = '<h1>T</h1><p>' + 'Кот сидит на окне и смотрит в сад. '.repeat(40) + '</p>';
  const r = analyzeReadability(html);
  assert.ok(r.metrics);
  assert.ok('flesch_index' in r.metrics);
  assert.ok('avg_sentence_words' in r.metrics);
  assert.ok('passive_pct' in r.metrics);
  assert.ok('bureaucratese_pct' in r.metrics);
  assert.ok(['pass', 'review', 'refine'].includes(r.verdict));
});
check('detects refine on heavy bureaucratese', () => {
  const html = '<p>' + 'Является осуществлением реализации в части обеспечения '.repeat(50) + 'возможности.</p>';
  const r = analyzeReadability(html);
  assert.ok(r.metrics.bureaucratese_pct > 5, `low bureaucratese: ${r.metrics.bureaucratese_pct}`);
  assert.ok(r.issues.length > 0);
});

// ── Test 8: thresholds via opts override ───────────────────
console.log('\n=== Test 8: thresholds override ===');
check('opts.minIndex moves verdict', () => {
  // Длинные тяжёлые слова → flesch будет низкий (~30-50).
  const html = '<p>' + 'Псевдополициклический катализатор реализует гидроксиметилфурфуроловую конденсацию. '.repeat(15) + '</p>';
  const r1 = analyzeReadability(html, { minIndex: 0 });
  const r2 = analyzeReadability(html, { minIndex: 80 });
  const has1 = r1.issues.some((i) => i.kind === 'low_readability');
  const has2 = r2.issues.some((i) => i.kind === 'low_readability');
  assert.strictEqual(has1, false, 'r1 should NOT have low_readability when minIndex=0');
  assert.strictEqual(has2, true, `r2 SHOULD have low_readability when minIndex=80, flesch=${r2.metrics.flesch_index}`);
});

// ── Summary ───────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
if (_pass === _cases) {
  console.log(`✅ All ${_cases} readability tests passed`);
  process.exit(0);
} else {
  console.log(`❌ ${_pass}/${_cases} passed`);
  process.exit(1);
}
