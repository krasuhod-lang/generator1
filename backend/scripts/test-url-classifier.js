'use strict';

/**
 * Тесты urlClassifier — классификация URL на информационные/коммерческие
 * страницы по сегментам пути.
 */

const assert = require('assert');
const {
  classifyUrl,
  isInformationalUrl,
  INFORMATIONAL,
  COMMERCIAL,
} = require('../src/services/reports/urlClassifier');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n      ${e.message}`); process.exitCode = 1; }
}

test('информационные разделы определяются по сегменту пути', () => {
  const infoUrls = [
    'https://site.com/blog/kak-vybrat-okna/',
    'https://site.com/articles/2024/seo',
    'https://site.com/guide/setup',
    'https://site.com/tutorials/step-1',
    'https://site.com/wiki/term',
    'https://site.com/news/launch',
    'https://site.com/faq/',
    'https://site.com/docs/api',
    'https://site.com/podcast/episode-3',
    'https://site.com/research/2024-report',
    'https://site.com/case-studies/client-x',
  ];
  for (const u of infoUrls) {
    const r = classifyUrl(u);
    assert.strictEqual(r.intent, INFORMATIONAL, `expected informational for ${u}`);
    assert.strictEqual(r.confident, true, `expected confident for ${u}`);
  }
});

test('коммерческие разделы определяются по сегменту пути', () => {
  const commUrls = [
    'https://site.com/catalog/smartphones/',
    'https://site.com/category/okna',
    'https://site.com/shop/',
    'https://site.com/products/iphone-15/',
    'https://site.com/services/montazh',
    'https://site.com/sale/',
    'https://site.com/cart',
    'https://site.com/checkout',
    'https://site.com/delivery',
    'https://site.com/b2b/',
    'https://site.com/wholesale/',
  ];
  for (const u of commUrls) {
    const r = classifyUrl(u);
    assert.strictEqual(r.intent, COMMERCIAL, `expected commercial for ${u}`);
    assert.strictEqual(r.confident, true, `expected confident for ${u}`);
  }
});

test('страница без маркеров считается коммерцией по умолчанию (не уверенно)', () => {
  const r = classifyUrl('https://site.com/plastikovye-okna-rehau/');
  assert.strictEqual(r.intent, COMMERCIAL);
  assert.strictEqual(r.confident, false);
  assert.strictEqual(r.marker, null);
});

test('главная страница без сегментов — коммерция по умолчанию', () => {
  const r = classifyUrl('https://site.com/');
  assert.strictEqual(r.intent, COMMERCIAL);
  assert.strictEqual(r.confident, false);
});

test('сегмент матчится целиком, без ложных срабатываний на подстроке', () => {
  // /particles/ не должен матчить article; /storefront/ не должен матчить store
  assert.strictEqual(classifyUrl('https://site.com/particles/x').confident, false);
  assert.strictEqual(classifyUrl('https://site.com/storefront/x').confident, false);
});

test('относительные пути и query/hash обрабатываются корректно', () => {
  assert.strictEqual(classifyUrl('/blog/post?utm=1#top').intent, INFORMATIONAL);
  assert.strictEqual(classifyUrl('/catalog/?page=2').intent, COMMERCIAL);
});

test('первый встреченный маркер по сегментам определяет интент', () => {
  // /catalog/ перед /review/ → коммерция (маркер раньше в пути)
  const r = classifyUrl('https://site.com/catalog/phones/review/');
  assert.strictEqual(r.intent, COMMERCIAL);
  assert.strictEqual(r.marker, 'catalog');
});

test('isInformationalUrl возвращает булево', () => {
  assert.strictEqual(isInformationalUrl('https://site.com/blog/x'), true);
  assert.strictEqual(isInformationalUrl('https://site.com/catalog/x'), false);
});

test('пустой/невалидный URL не падает и считается коммерцией', () => {
  assert.strictEqual(classifyUrl('').intent, COMMERCIAL);
  assert.strictEqual(classifyUrl(null).intent, COMMERCIAL);
  assert.strictEqual(classifyUrl('not a url').intent, COMMERCIAL);
});

if (!process.exitCode) console.log(`\n${passed} tests passed`);
