'use strict';

/**
 * test-intent-verify.js — юнит-тесты для intentVerify.service.js
 * (Phase 2 / Б5).
 * Запуск:  node backend/scripts/test-intent-verify.js
 */

const assert = require('assert');
const path   = require('path');

const { detectArticleIntent, verifyIntent } = require(
  path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'intentVerify.service'),
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

// ── Test 1: detectArticleIntent ──────────────────────────────────────
console.log('\n=== Test 1: detectArticleIntent ===');
check('info-statья → intent=info', () => {
  const html = '<h1>Как выбрать диван</h1>'
    + '<p>В этой статье разберёмся, как и почему стоит выбирать диван. </p>'.repeat(30)
    + '<h2>Часто задаваемые вопросы</h2>'
    + '<h3>Какие типы диванов бывают?</h3>'
    + '<p>Есть руководство и инструкция по выбору.</p>';
  const r = detectArticleIntent(html);
  assert.ok(['info', 'mixed'].includes(r.intent), `expected info/mixed, got ${r.intent}`);
  assert.ok(r.signals.faq_block);
});

check('коммерческая страница → intent=commercial', () => {
  const html = '<h1>Цена на диваны</h1>'
    + '<p>Цена 25 000 руб. Стоимость зависит от обивки. ' .repeat(20)
    + '<p>Сравнение моделей. Рейтинг лучших. Обзор характеристик. Преимущества и выбор.</p>'.repeat(10);
  const r = detectArticleIntent(html);
  assert.ok(['commercial', 'mixed', 'transactional'].includes(r.intent), `got ${r.intent}`);
  assert.ok(r.signals.price_mentions > 0);
});

check('транзакционная → intent=transactional', () => {
  const html = '<h1>Купить диван</h1>'
    + '<a class="btn buy">Купить сейчас</a>'.repeat(5)
    + '<p>Купить, заказать, оформить заказ. Доставка бесплатна. Скидка 20%.</p>'.repeat(20);
  const r = detectArticleIntent(html);
  assert.ok(['transactional', 'mixed'].includes(r.intent), `got ${r.intent}`);
  assert.ok(r.signals.transactional_markers > 0);
});

check('пустая статья → intent=info (default)', () => {
  const r = detectArticleIntent('');
  assert.strictEqual(r.intent, 'info');
});

// ── Test 2: verifyIntent ──────────────────────────────────────
console.log('\n=== Test 2: verifyIntent ===');
check('verdict=na if no competitor signals', () => {
  const html = '<h1>T</h1>' + '<p>Текст статьи. </p>'.repeat(50);
  const r = verifyIntent(html, null);
  assert.strictEqual(r.verdict, 'na');
});

check('verdict=na if too short', () => {
  const r = verifyIntent('<p>Короткая.</p>', { serp_intent: { dominant_intent: 'info' } });
  assert.strictEqual(r.verdict, 'na');
  assert.strictEqual(r.reason, 'too_short');
});

check('verdict=pass when intents match', () => {
  const html = '<h1>Как выбрать</h1>'
    + '<p>Как и почему стоит. Руководство. Инструкция. Разбираемся. ' .repeat(40);
  const r = verifyIntent(html, { serp_intent: { dominant_intent: 'info' } });
  assert.strictEqual(r.verdict, 'pass');
  assert.strictEqual(r.mismatch, false);
});

check('verdict=mismatch + critical when info article vs transactional SERP', () => {
  const html = '<h1>Как выбрать</h1>'
    + '<p>Как и почему стоит. Руководство. Инструкция. Разбираемся. ' .repeat(40);
  const r = verifyIntent(html, { serp_intent: { dominant_intent: 'transactional' } });
  assert.strictEqual(r.verdict, 'mismatch');
  assert.strictEqual(r.critical, true);
  assert.ok(r.recommendation);
});

check('mixed article matches if SERP intent in top_pair', () => {
  const html = '<h1>Купить и сравнить</h1>'
    + '<a class="cta buy">купить</a>'.repeat(3)
    + '<p>Купить, цена, стоимость, рейтинг, сравнение, лучшие модели. ' .repeat(60);
  const r = verifyIntent(html, { serp_intent: { dominant_intent: 'transactional' } });
  assert.ok(['pass', 'review'].includes(r.verdict),
    `expected pass/review, got ${r.verdict} (article=${r.article_intent}, words=${r.details.detection.signals.word_count})`);
});

// ── Summary ──────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
if (_pass === _cases) {
  console.log(`✅ All ${_cases} intentVerify tests passed`);
  process.exit(0);
} else {
  console.log(`❌ ${_pass}/${_cases} passed`);
  process.exit(1);
}
