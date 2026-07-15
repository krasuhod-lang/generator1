'use strict';

/**
 * Smoke-tests for metaTags snippetAnalyzer + keyword position check (Task A).
 *
 * Запуск: node backend/scripts/test-snippet-analyzer.js
 */

const assert = require('assert');
const { analyzeSnippets } = require('../src/services/metaTags/snippetAnalyzer');
const { checkKeywordPosition } = require('../src/services/metaTags/semantics');
const { _deriveSerpFeatures } = require('../src/services/metaTags/xmlstockClient');

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

const serp = [
  {
    serp_title: 'Пластиковые окна в Москве — ОкнаПро',
    serp_description: 'Закажите пластиковые окна с гарантией. Доступные цены и высокий рейтинг 4.8 из 5.',
  },
  {
    title: 'Пластиковые окна в Москве — ДомОкна',
    snippet: 'Купите пластиковые окна под ключ. Доступные цены, отзывы клиентов и гарантия.',
  },
  {
    title: 'Топ 10 окон ПВХ 2026',
    snippet: 'Лучший выбор для квартиры. Подробнее о профилях и монтаже.',
  },
];

test('analyzeSnippets: базовый контракт и длины конкурентов', () => {
  const res = analyzeSnippets(serp);
  assert.ok(res.dominant_title_pattern);
  assert.ok(Array.isArray(res.repeated_phrases));
  assert.strictEqual(res.used_numbers, true);
  assert.strictEqual(res.used_year, true);
  assert.ok(res.competitor_title_lengths.min > 0);
  assert.ok(res.competitor_title_lengths.max >= res.competitor_title_lengths.min);
  assert.ok(res.competitor_desc_lengths.avg > 0);
});

test('analyzeSnippets: повторяющиеся n-grams и CTA попадают в noise', () => {
  const res = analyzeSnippets(serp);
  assert.ok(
    res.repeated_phrases.some((p) => p.includes('пластиковые окна')),
    `repeated=${res.repeated_phrases.join('|')}`,
  );
  assert.ok(res.cta_patterns.includes('закажите'));
  assert.ok(res.cta_patterns.includes('купите'));
  assert.ok(
    res.competitor_noise.includes('доступные цены'),
    `noise=${res.competitor_noise.join('|')}`,
  );
});

test('analyzeSnippets: пустой SERP возвращает безопасные дефолты', () => {
  const res = analyzeSnippets([]);
  assert.strictEqual(res.dominant_title_pattern, 'plain');
  assert.deepStrictEqual(res.repeated_phrases, []);
  assert.strictEqual(res.used_numbers, false);
  assert.strictEqual(res.competitor_title_lengths.avg, 0);
});

test('checkKeywordPosition: полная фраза в первых 35 символах проходит', () => {
  const res = checkKeywordPosition('Пластиковые окна в Москве — гарантия 5 лет', 'пластиковые окна москва');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.position, 0);
});

test('checkKeywordPosition: первый токен по стемму проходит морфологически', () => {
  const res = checkKeywordPosition('Оконные системы Rehau — монтаж за день', 'окна rehau');
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.position, 0);
});

test('checkKeywordPosition: позднее вхождение не проходит, но позиция возвращается', () => {
  const res = checkKeywordPosition(
    'Надёжный монтаж под ключ с гарантией мастера — пластиковые окна',
    'пластиковые окна',
  );
  assert.strictEqual(res.ok, false);
  assert.ok(res.position >= 35, `position=${res.position}`);
});

test('_deriveSerpFeatures: extended/date/price/rating flags', () => {
  const text = `${'Описание '.repeat(25)}Цена от 9900 ₽, рейтинг 4.8 из 5, 2026.`;
  const res = _deriveSerpFeatures(text);
  assert.strictEqual(res.type, 'extended');
  assert.strictEqual(res.has_date, true);
  assert.strictEqual(res.has_price, true);
  assert.strictEqual(res.has_rating, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
