'use strict';

/**
 * Smoke-tests for metaTags SERP CTR analyzer + two-tier LSI (ТЗ §2.5).
 *
 *  • analyzeSerpCtr: корректные length_p50/p90, обнаружение года/цены/CTA/гео,
 *    выделение weak titles, формула.
 *  • extractSemantics: obligatory_lsi (DF≥50%), differentiator_lsi (DF=0),
 *    df_map, serp_doc_count.
 *
 * Запуск:  node backend/scripts/test-meta-serp-ctr.js
 */

const assert = require('assert');
const { analyzeSerpCtr, _percentile } = require('../src/services/metaTags/serpCtrAnalyzer');
const { extractSemantics, checkLsiUsage } = require('../src/services/metaTags/semantics');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`✗ ${name}\n  ${err.message}`);
    failed += 1;
  }
}

// ── Фикстура: реалистичная выдача «пластиковые окна Москва» ────────────
const serp = [
  { url: 'a.ru', title: 'Купить пластиковые окна в Москве 2026 | от 9 990 ₽',
    snippet: 'Закажите окна с гарантией 10 лет. Бесплатный замер.' },
  { url: 'b.ru', title: 'Пластиковые окна — установка под ключ в Москве 2026',
    snippet: 'Окна по цене от 8 500 ₽. Звоните!' },
  { url: 'c.ru', title: 'Окна ПВХ от производителя в Москве 2026',
    snippet: 'Гарантия 7 лет. Доставка бесплатно. Закажите.' },
  { url: 'd.ru', title: 'Дешёвые окна',
    snippet: 'Доступные цены.' },
];

test('_percentile: edge cases', () => {
  assert.strictEqual(_percentile([], 50), 0);
  assert.strictEqual(_percentile([10, 20, 30, 40], 50), 30);
  assert.strictEqual(_percentile([100], 90), 100);
});

test('extractSemantics: obligatory_lsi found at DF >= 50%', () => {
  const sem = extractSemantics('пластиковые окна москва', serp);
  // "окна" / "москв" в 3-4 из 4 сниппетов → должны попасть в obligatory.
  assert.ok(sem.obligatory_lsi.length > 0, 'must have obligatory LSI');
  assert.ok(
    sem.obligatory_lsi.some((w) => w.startsWith('окн')),
    `expected stemmed "окна" in obligatory, got: ${sem.obligatory_lsi.join(',')}`,
  );
  assert.strictEqual(sem.serp_doc_count, 4);
  assert.ok(sem.df_map && Object.keys(sem.df_map).length > 0, 'df_map should be populated');
});

test('extractSemantics: differentiator_lsi = tokens not in any SERP doc', () => {
  // "триплекс" и "монтаж" — добавлены в ключ, но их нет ни в одном тайтле/сниппете.
  const sem = extractSemantics('пластиковые окна москва триплекс монтаж', serp);
  assert.ok(sem.differentiator_lsi.length > 0, 'must have differentiators');
  assert.ok(
    sem.differentiator_lsi.some((w) => w.includes('триплекс') || w.startsWith('триплекс')),
    `expected "триплекс" in diff, got: ${sem.differentiator_lsi.join(',')}`,
  );
});

test('analyzeSerpCtr: length percentiles correct', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'пластиковые окна москва' });
  assert.ok(ctr.patterns.length_p50_title > 20, 'p50 should be > 20');
  assert.ok(ctr.patterns.length_p90_title >= ctr.patterns.length_p50_title, 'p90 >= p50');
});

test('analyzeSerpCtr: year detected in 50% of titles', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  // 3 of 4 titles contain 2026 → year_frequency = 0.75
  assert.ok(ctr.patterns.year_frequency >= 0.5, `year_frequency=${ctr.patterns.year_frequency}`);
});

test('analyzeSerpCtr: CTA detected in descriptions', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  // "Закажите", "Звоните!" → cta_frequency > 0
  assert.ok(ctr.patterns.cta_frequency > 0, `cta_frequency=${ctr.patterns.cta_frequency}`);
});

test('analyzeSerpCtr: price detected', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  assert.ok(ctr.patterns.price_frequency > 0, `price_frequency=${ctr.patterns.price_frequency}`);
});

test('analyzeSerpCtr: geo detected (Москве)', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  assert.ok(ctr.patterns.geo_frequency >= 0.5, `geo_frequency=${ctr.patterns.geo_frequency}`);
});

test('analyzeSerpCtr: weak titles identified', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  // "Дешёвые окна" — короткий, без года, без emotional triggers.
  assert.ok(
    ctr.patterns.questionable_titles.includes('Дешёвые окна'),
    `weak titles: ${ctr.patterns.questionable_titles.join('|')}`,
  );
});

test('analyzeSerpCtr: recommendations include must_have for year>=40%', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  const hasYearRec = ctr.recommendations.must_have.some((r) => /год/i.test(r));
  assert.ok(hasYearRec, `must_have should mention year: ${ctr.recommendations.must_have.join('|')}`);
});

test('analyzeSerpCtr: recommendations include differentiation when diff LSI present', () => {
  const sem = extractSemantics('окна монтаж триплекс', serp);
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна монтаж триплекс', semantics: sem });
  assert.ok(
    ctr.recommendations.differentiation.some((r) => /уникальн|нет ни у кого/i.test(r)),
    `differentiation: ${ctr.recommendations.differentiation.join('|')}`,
  );
});

test('analyzeSerpCtr: suggested_title_formula non-empty', () => {
  const ctr = analyzeSerpCtr(serp, { keyword: 'окна' });
  assert.ok(ctr.recommendations.suggested_title_formula.length > 0);
});

test('analyzeSerpCtr: empty SERP returns sane defaults', () => {
  const ctr = analyzeSerpCtr([], { keyword: 'foo' });
  assert.strictEqual(ctr.competitor_titles.length, 0);
  assert.strictEqual(ctr.patterns.length_p50_title, 0);
  assert.strictEqual(ctr.patterns.cta_frequency, 0);
  assert.strictEqual(typeof ctr.recommendations.suggested_title_formula, 'string');
});

test('checkLsiUsage: stemmed match counts as used', () => {
  // "Москве" (форма) должна засчитаться за LSI "Москва" через стеммер.
  const res = checkLsiUsage('Купить пластиковые окна в Москве', ['окна', 'москва']);
  assert.strictEqual(res.used_lsi.length, 2, `used: ${res.used_lsi.join(',')}`);
  assert.strictEqual(res.missed_lsi.length, 0);
});

test('extractSemantics → analyzeSerpCtr integration: obligatory LSI reach prompt', () => {
  const sem = extractSemantics('пластиковые окна', serp);
  const ctr = analyzeSerpCtr(serp, { keyword: 'пластиковые окна', semantics: sem });
  const obligatoryMention = ctr.recommendations.must_have.find((r) => /Обязательные LSI/i.test(r));
  assert.ok(obligatoryMention, `must_have should list obligatory LSI: ${ctr.recommendations.must_have.join('|')}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
