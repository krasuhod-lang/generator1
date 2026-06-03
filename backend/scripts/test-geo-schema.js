'use strict';

/**
 * Smoke-тесты для backend/src/services/seo/geoSchema.js и geoExtractor.js.
 * Запуск: node backend/scripts/test-geo-schema.js
 */

const assert = require('assert');
const {
  buildArticleJsonLd,
  buildFaqPageJsonLd,
  buildHowToJsonLd,
  buildBreadcrumbListJsonLd,
  buildOrganizationJsonLd,
  buildItemListJsonLd,
  serializeJsonLdScript,
  assembleJsonLdScripts,
  sanitizeText,
  sanitizeUrl,
  sanitizeDate,
} = require('../src/services/seo/geoSchema');
const {
  extractH1,
  extractFaqItems,
  extractHowToSteps,
  extractLeadAnswer,
  buildArticleDescription,
} = require('../src/services/seo/geoExtractor');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
}

console.log('geoSchema — sanitize');
t('sanitizeText strips tags & entities', () => {
  assert.strictEqual(sanitizeText('<b>hello</b>&nbsp;world&amp;'), 'hello world&');
});
t('sanitizeText drops literal < >', () => {
  // <…> воспринимается как тег и удаляется regexp'ом полностью.
  assert.strictEqual(sanitizeText('a < b > c'), 'a c');
  // Несбалансированные одиночные < или > — тоже удаляются.
  assert.strictEqual(sanitizeText('safe < text'), 'safe text');
});
t('sanitizeText handles non-string', () => {
  assert.strictEqual(sanitizeText(null), '');
  assert.strictEqual(sanitizeText(123), '');
});
t('sanitizeText truncates', () => {
  const s = sanitizeText('x'.repeat(1000), 50);
  assert.strictEqual(s.length, 50);
});
t('sanitizeUrl accepts https', () => {
  assert.strictEqual(sanitizeUrl('https://example.com/a'), 'https://example.com/a');
});
t('sanitizeUrl rejects javascript:', () => {
  assert.strictEqual(sanitizeUrl('javascript:alert(1)'), null);
});
t('sanitizeUrl rejects data:', () => {
  assert.strictEqual(sanitizeUrl('data:image/png;base64,XXX'), null);
});
t('sanitizeDate accepts ISO', () => {
  assert.match(sanitizeDate('2026-01-15'), /^2026-01-15T/);
});
t('sanitizeDate rejects garbage', () => {
  assert.strictEqual(sanitizeDate('завтра'), null);
});

console.log('geoSchema — Article');
t('Article requires headline', () => {
  assert.strictEqual(buildArticleJsonLd({}), null);
});
t('Article minimal', () => {
  const a = buildArticleJsonLd({ headline: 'Тема' });
  assert.strictEqual(a['@type'], 'Article');
  assert.strictEqual(a.headline, 'Тема');
});
t('Article full with author', () => {
  const a = buildArticleJsonLd({
    headline: 'Hello',
    description: 'Desc',
    datePublished: '2026-01-01',
    dateModified: '2026-02-01',
    author: { name: 'Иван', jobTitle: 'эксперт', url: 'https://x.com/ivan' },
    publisher: { name: 'Generator', url: 'https://gen.example' },
    image: 'https://i.example/cover.jpg',
    inLanguage: 'ru-RU',
    articleType: 'BlogPosting',
  });
  assert.strictEqual(a['@type'], 'BlogPosting');
  assert.strictEqual(a.author.name, 'Иван');
  assert.strictEqual(a.author.jobTitle, 'эксперт');
  assert.strictEqual(a.publisher.name, 'Generator');
  assert.strictEqual(a.image, 'https://i.example/cover.jpg');
  assert.match(a.datePublished, /^2026-01-01/);
  assert.strictEqual(a.inLanguage, 'ru-RU');
});
t('Article ignores bad author url', () => {
  const a = buildArticleJsonLd({ headline: 'X', author: { name: 'a', url: 'javascript:1' } });
  assert.strictEqual(a.author.url, undefined);
});

console.log('geoSchema — FAQPage');
t('FAQPage empty → null', () => {
  assert.strictEqual(buildFaqPageJsonLd([]), null);
  assert.strictEqual(buildFaqPageJsonLd(null), null);
});
t('FAQPage skips invalid', () => {
  const f = buildFaqPageJsonLd([
    { question: 'Q1', answer: 'A1' },
    { question: '', answer: 'X' },
    { question: 'Q2', answer: 'A2' },
  ]);
  assert.strictEqual(f.mainEntity.length, 2);
  assert.strictEqual(f.mainEntity[0].acceptedAnswer.text, 'A1');
});

console.log('geoSchema — HowTo');
t('HowTo needs ≥2 steps', () => {
  assert.strictEqual(buildHowToJsonLd({ name: 'X', steps: [{ text: 'a' }] }), null);
});
t('HowTo full', () => {
  const h = buildHowToJsonLd({ name: 'Как сделать', steps: ['Шаг А', { name: 'Шаг 2', text: 'B' }] });
  assert.strictEqual(h['@type'], 'HowTo');
  assert.strictEqual(h.step.length, 2);
  assert.strictEqual(h.step[0].position, 1);
  assert.strictEqual(h.step[1].name, 'Шаг 2');
});

console.log('geoSchema — Breadcrumb / Organization / ItemList');
t('Breadcrumb', () => {
  const b = buildBreadcrumbListJsonLd([
    { name: 'Главная', url: 'https://shop.example' },
    { name: 'Категория' },
  ]);
  assert.strictEqual(b.itemListElement.length, 2);
  assert.strictEqual(b.itemListElement[1].position, 2);
});
t('Organization', () => {
  const o = buildOrganizationJsonLd({ name: 'X', url: 'https://x.example' });
  assert.strictEqual(o.url, 'https://x.example');
});
t('ItemList with items + about', () => {
  const il = buildItemListJsonLd({
    name: 'Тачки',
    items: ['Бренд A', { name: 'Материал X', url: 'https://x.example/m' }],
    about: ['пневматические колёса'],
  });
  assert.strictEqual(il.itemListElement.length, 2);
  assert.deepStrictEqual(il.about, ['пневматические колёса']);
});

console.log('geoSchema — serialize');
t('serializeJsonLdScript wraps with <script>', () => {
  const s = serializeJsonLdScript({ '@type': 'Thing', name: 'X' });
  assert.match(s, /^<script type="application\/ld\+json">/);
  assert.match(s, /<\/script>$/);
});
t('serializeJsonLdScript escapes </script>', () => {
  const s = serializeJsonLdScript({ name: '</script><img src=x onerror=alert(1)>' });
  assert.ok(!/<\/script>(?!$)/i.test(s.slice(0, -9)),
    'inner </script> must be escaped');
});
t('assembleJsonLdScripts filters null', () => {
  const r = assembleJsonLdScripts([null, { '@type': 'A', name: 'a' }, undefined]);
  assert.strictEqual(r.length, 1);
});

console.log('geoExtractor');
const SAMPLE = `
<h1>Тестовая статья</h1>
<p class="byline">Автор Иван</p>
<p class="lead-answer">Прямой ответ читателю в первых ста словах статьи.</p>
<nav class="toc"><ol><li><a href="#sec-1">Раздел 1</a></li></ol></nav>
<h2>Раздел 1</h2>
<p class="answer-lead">Короткий прямой ответ на подвопрос.</p>
<p>Развёрнутое объяснение.</p>
<ol class="howto">
  <li>Шаг 1. Сделайте первое действие</li>
  <li>Шаг 2. Сделайте второе действие</li>
  <li>Шаг 3. Завершите процесс</li>
</ol>
<h2>Часто задаваемые вопросы</h2>
<h3>Сколько это стоит?</h3>
<p>В среднем недорого.</p>
<h3>Как долго делается?</h3>
<p>Обычно 2 недели.</p>
<h2>Заключение</h2>
<p>Итог.</p>`;

t('extractH1', () => {
  assert.strictEqual(extractH1(SAMPLE), 'Тестовая статья');
});
t('extractLeadAnswer', () => {
  assert.match(extractLeadAnswer(SAMPLE), /Прямой ответ читателю/);
});
t('extractFaqItems', () => {
  const faq = extractFaqItems(SAMPLE);
  assert.strictEqual(faq.length, 2);
  assert.strictEqual(faq[0].question, 'Сколько это стоит?');
  assert.match(faq[1].answer, /Обычно 2 недели/);
});
t('extractHowToSteps', () => {
  const steps = extractHowToSteps(SAMPLE);
  assert.strictEqual(steps.length, 3);
  assert.match(steps[0].text, /первое действие/);
});
t('buildArticleDescription uses lead-answer', () => {
  const d = buildArticleDescription(SAMPLE);
  assert.match(d, /Прямой ответ/);
});
t('buildArticleDescription falls back to first <p>', () => {
  const html = '<h1>X</h1><p>Длинный первый абзац без класса lead-answer, описывающий статью подробно.</p>';
  assert.match(buildArticleDescription(html), /Длинный первый абзац/);
});
t('extractFaqItems empty when no FAQ', () => {
  assert.deepStrictEqual(extractFaqItems('<h1>X</h1><p>nope</p>'), []);
});

console.log('\n──────────────');
console.log(`passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
