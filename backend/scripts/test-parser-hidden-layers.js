'use strict';

/* Smoke-тест hiddenLayers extractor: парсит fixture HTML и проверяет, что
 * вытаскиваются JSON-LD, microdata, meta-теги, noscript, hreflang, hidden. */

const assert  = require('assert');
const cheerio = require('cheerio');
const { extractHiddenLayers, summarizeHiddenLayers, _safeJsonParse } = require('../src/services/parser/hiddenLayers');

let passed = 0; let failed = 0;
function t(name, fn) {
  try { fn(); console.log('✓', name); passed++; }
  catch (e) { console.error('✗', name, '\n  ', e.message); failed++; }
}

const HTML = `<!doctype html>
<html lang="ru">
<head>
  <title>Тестовая страница CRM</title>
  <meta name="description" content="Подробный обзор внедрения CRM" />
  <meta name="keywords" content="crm, внедрение, обзор" />
  <meta name="robots" content="index,follow" />
  <link rel="canonical" href="/crm/page" />
  <link rel="alternate" hreflang="en" href="https://ex.com/en/crm" />
  <link rel="alternate" hreflang="ru" href="https://ex.com/ru/crm" />
  <link rel="alternate" type="application/rss+xml" href="/feed.rss" />
  <link rel="sitemap" href="/sitemap.xml" />
  <link rel="amphtml" href="/amp/crm" />
  <meta property="og:title" content="OG title CRM" />
  <meta property="og:image" content="https://ex.com/img.jpg" />
  <meta name="twitter:card" content="summary_large_image" />
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"Что такое CRM?","acceptedAnswer":{"@type":"Answer","text":"Система."}}]}</script>
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[]}</script>
  <script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"x":1}},"page":"/crm","query":{"id":"42"},"buildId":"abc"}</script>
</head>
<body>
  <h1 itemprop="headline">Заголовок CRM</h1>
  <div itemprop="author" content="Иван Иванов"></div>
  <noscript>JS отключён — fallback контент</noscript>
  <template id="modal-tpl"><p>Скрытый шаблон модалки</p></template>
  <div hidden>Скрытый блок с важным контекстом</div>
  <div aria-hidden="true">aria-скрытый блок</div>
  <span style="display:none">display none span</span>
  <span style="visibility: hidden">visibility hidden</span>
  <p>Видимый параграф</p>
</body>
</html>`;

t('extractHiddenLayers: вытаскивает JSON-LD и считает количество', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  assert.strictEqual(out.meta_signals.ld_count, 2);
  assert.strictEqual(out.structured_data.jsonld.length, 2);
  assert.strictEqual(out.structured_data.jsonld[0]['@type'], 'FAQPage');
});

t('extractHiddenLayers: __NEXT_DATA__ → page/query/buildId', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  assert.ok(out.structured_data.next_data);
  assert.strictEqual(out.structured_data.next_data.page, '/crm');
  assert.strictEqual(out.structured_data.next_data.query.id, '42');
});

t('extractHiddenLayers: meta tags + canonical + OG/twitter', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  assert.strictEqual(out.meta_signals.title, 'Тестовая страница CRM');
  assert.ok(out.meta_signals.description.includes('CRM'));
  assert.strictEqual(out.meta_signals.canonical, 'https://ex.com/crm/page');
  assert.strictEqual(out.meta_signals.og.title, 'OG title CRM');
  assert.strictEqual(out.meta_signals.twitter.card, 'summary_large_image');
});

t('extractHiddenLayers: hreflang массив', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  assert.strictEqual(out.meta_signals.hreflang.length, 2);
  const langs = out.meta_signals.hreflang.map((h) => h.lang).sort();
  assert.deepStrictEqual(langs, ['en', 'ru']);
});

t('extractHiddenLayers: sitemap + RSS feed', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  assert.strictEqual(out.sitemap_hints.sitemap_urls.length, 1);
  assert.ok(out.sitemap_hints.sitemap_urls[0].endsWith('/sitemap.xml'));
  assert.strictEqual(out.sitemap_hints.feed_urls.length, 1);
});

t('extractHiddenLayers: noscript / template / hidden / display:none', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  assert.ok(out.hidden_text.noscript.some((s) => s.includes('JS отключён')));
  assert.ok(out.hidden_text.template.some((s) => s.includes('Скрытый шаблон')));
  assert.ok(out.hidden_text.hidden_attr.some((s) => s.includes('Скрытый блок')));
  assert.ok(out.hidden_text.hidden_attr.some((s) => s.includes('aria-скрытый')));
  assert.ok(out.hidden_text.display_none.some((s) => s.includes('display none span')));
  assert.ok(out.hidden_text.display_none.some((s) => s.includes('visibility hidden')));
});

t('extractHiddenLayers: microdata собирает itemprop', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  const props = out.structured_data.microdata.map((m) => m.prop);
  assert.ok(props.includes('headline'));
  assert.ok(props.includes('author'));
  const author = out.structured_data.microdata.find((m) => m.prop === 'author');
  assert.strictEqual(author.value, 'Иван Иванов');
});

t('summarizeHiddenLayers: содержит JSON-LD/Next/noscript', () => {
  const $ = cheerio.load(HTML);
  const out = extractHiddenLayers($, { baseUrl: 'https://ex.com/crm/page' });
  const s = summarizeHiddenLayers(out);
  assert.ok(s.includes('JSON-LD: 2'));
  assert.ok(s.includes('FAQPage'));
  assert.ok(s.includes('Next✓'));
  assert.ok(s.includes('canonical✓'));
  assert.ok(s.includes('noscript: 1'));
});

t('_safeJsonParse: чинит trailing comma', () => {
  const parsed = _safeJsonParse('{"a":1,"b":2,}');
  assert.deepStrictEqual(parsed, { a: 1, b: 2 });
});

t('_safeJsonParse: невалидный → null', () => {
  assert.strictEqual(_safeJsonParse('{not json}'), null);
  assert.strictEqual(_safeJsonParse(''), null);
  assert.strictEqual(_safeJsonParse(null), null);
});

t('extractHiddenLayers: пустой документ → пустые поля без падений', () => {
  const $ = cheerio.load('<html><body></body></html>');
  const out = extractHiddenLayers($);
  assert.strictEqual(out.meta_signals.ld_count, 0);
  assert.strictEqual(out.structured_data.jsonld.length, 0);
  assert.strictEqual(out.structured_data.next_data, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
