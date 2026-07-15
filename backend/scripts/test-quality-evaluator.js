'use strict';

const assert = require('assert');
const {
  computeFactualDensity,
  computeCompositeScore,
  normalizePairwiseResult,
  _internal,
} = require('../src/services/pipeline/stage8');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  ✘ ${name}\n    ${e.stack || e.message}`);
  }
}

console.log('quality evaluator');

test('computeFactualDensity считает конкретные факты и даёт высокий score', () => {
  const text = 'В 2026 году монтаж стоит 12 000 руб. Толщина профиля 70 мм, гарантия 5 лет. Rehau 70 подходит для -30 °C.';
  const r = _internal.computeFactualDensityDetails(text);
  assert.ok(r.facts >= 4, `facts=${r.facts}`);
  assert.strictEqual(computeFactualDensity(text), r.score);
  assert.ok(computeFactualDensity(text) > 50, `score=${r.score}`);
});

test('computeFactualDensity на водяном тексте возвращает низкий score', () => {
  assert.strictEqual(computeFactualDensity('Это полезная статья о выборе решения без цифр и конкретных параметров.'), 0);
});

test('computeCompositeScore использует полные веса', () => {
  const score = computeCompositeScore({
    gist_coverage: 80,
    replaceability_score: 70,
    factual_density: 60,
    eeat_score: 90,
    lsi_coverage: 100,
  });
  assert.strictEqual(score, 79);
});

test('computeCompositeScore renormalizes missing criteria', () => {
  const score = computeCompositeScore({
    gist_coverage: 100,
    replaceability_score: null,
    factual_density: 50,
  });
  // (100*25 + 50*20) / (25+20) = 77.777...
  assert.strictEqual(score, 77.78);
});

test('computeCompositeScore returns null if all criteria missing', () => {
  assert.strictEqual(computeCompositeScore({}), null);
});

test('normalizePairwiseResult accepts explicit winner', () => {
  const r = normalizePairwiseResult({ winner: 'variant_a', scores: { a: 88, b: 75 }, rationale: 'A конкретнее' });
  assert.deepStrictEqual(r, { winner: 'a', scores: { a: 88, b: 75 }, rationale: 'A конкретнее' });
});

test('normalizePairwiseResult infers winner from scores', () => {
  const r = normalizePairwiseResult({ score_a: 61, score_b: 73 });
  assert.strictEqual(r.winner, 'b');
  assert.deepStrictEqual(r.scores, { a: 61, b: 73 });
});

test('normalizePairwiseResult treats close scores as tie', () => {
  const r = normalizePairwiseResult({ scores: { a: 80, b: 80.5 } });
  assert.strictEqual(r.winner, 'tie');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
