'use strict';

/**
 * Smoke-тесты TZ parser/compliance без БД и сети.
 * Запуск: node backend/scripts/test-tz-parser.js
 */

const assert = require('assert');
const { normalizeTz, hasTz } = require('../src/services/pipeline/tzParser');
const { checkTzCompliance } = require('../src/services/pipeline/tzComplianceChecker');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✔ ${name}`);
  } catch (e) {
    console.log(`  ✘ ${name}\n    ${e.stack || e.message}`);
    process.exitCode = 1;
  }
}

console.log('tzParser');

test('normalizeTz мапит алиасы relevance/manual схем', () => {
  const tz = normalizeTz({
    title_h1: 'Пластиковые окна в Москве',
    headers: ['Цены на окна', 'Этапы монтажа'],
    volume: 'от 1200 до 1800 слов',
    keywords: 'пластиковые окна; монтаж окон',
    forbidden_words: ['дешево без гарантии'],
    faq: 'да',
    table: true,
    entities: [{ name: 'REHAU' }, { text: 'ГОСТ' }],
  });

  assert.strictEqual(tz.h1_required, 'Пластиковые окна в Москве');
  assert.deepStrictEqual(tz.h2_required, ['Цены на окна', 'Этапы монтажа']);
  assert.strictEqual(tz.min_words, 1200);
  assert.strictEqual(tz.max_words, 1800);
  assert.deepStrictEqual(tz.lsi_required, ['пластиковые окна', 'монтаж окон']);
  assert.deepStrictEqual(tz.lsi_forbidden, ['дешево без гарантии']);
  assert.strictEqual(tz.faq_required, true);
  assert.strictEqual(tz.table_required, true);
  assert.deepStrictEqual(tz.entity_anchors, ['REHAU', 'ГОСТ']);
});

test('hasTz требует непустой tz_json и tz_source', () => {
  assert.strictEqual(hasTz({ tz_json: { h1_required: 'H1' }, tz_source: 'manual' }), true);
  assert.strictEqual(hasTz({ tz_json: { h1_required: 'H1' } }), false);
  assert.strictEqual(hasTz({ tz_json: {}, tz_source: 'manual' }), false);
});

console.log('tzComplianceChecker');

test('checkTzCompliance считает score и нарушения на синтетическом HTML', () => {
  const tz = normalizeTz({
    h1: 'Пластиковые окна в Москве',
    h2_required: ['Цены на окна', 'Этапы монтажа'],
    min_words: 20,
    max_words: 80,
    lsi_required: ['монтаж пластиковых окон', 'гарантия'],
    lsi_forbidden: ['без гарантии'],
  });
  const html = `
    <h1>Пластиковые окна в Москве под ключ</h1>
    <h2>Цены на окна</h2>
    <p>Монтаж пластиковых окон выполняется по договору. Есть гарантия на работы.</p>
    <h2>Этапы монтажа</h2>
    <p>Замер, производство, доставка и аккуратная установка профиля в квартире.</p>
  `;

  const report = checkTzCompliance({ tz, fullHtml: html });
  assert.strictEqual(report.h1_match.present, true);
  assert.ok(report.h2_required_present.every((x) => x.present));
  assert.strictEqual(report.word_count_ok, true);
  assert.strictEqual(report.lsi_forbidden_violations.length, 0);
  assert.ok(report.lsi_required_coverage >= 0.5);
  assert.ok(report.tz_compliance_score >= 80, `score=${report.tz_compliance_score}`);
});

test('checkTzCompliance снижает score при missing H2 и forbidden', () => {
  const report = checkTzCompliance({
    tz: {
      h1_required: 'Пластиковые окна',
      h2_required: ['Цены', 'Гарантии'],
      min_words: 5,
      lsi_required: ['монтаж окон'],
      lsi_forbidden: ['без гарантии'],
    },
    fullHtml: '<h1>Пластиковые окна</h1><h2>Цены</h2><p>Монтаж окон без гарантии и договора.</p>',
  });

  assert.ok(report.tz_compliance_score < 80);
  assert.ok(report.needs_rewrite.includes('h2_required'));
  assert.deepStrictEqual(report.lsi_forbidden_violations, ['без гарантии']);
});
