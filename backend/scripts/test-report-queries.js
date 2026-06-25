'use strict';

/**
 * Тесты разбиения top_queries / top_pages в отчёте по интенту (ТЗ §4).
 *
 * Покрывают:
 *  - _classifyQueries проставляет intent/commercial/branded
 *  - _splitQueries делит на commercial / informational / other и сортирует
 *  - _splitPages помечает страницу commercial по доле commercial-кликов
 *  - _summarizeCommercial считает абсолюты и % коммерческой доли
 */

const assert = require('assert');
const {
  _classifyQueries,
  _splitQueries,
  _splitPages,
  _buildPagesWithQueries,
  _buildYandexQueriesAsPages,
  _summarizeCommercial,
} = require('../src/services/reports/dataAggregator');
const { deriveBrandTokens } = require('../src/services/projects/commercialIntent');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n      ${e.message}`); process.exitCode = 1; }
}

const rows = [
  { key: 'купить пластиковые окна', clicks: 120, impressions: 1500, ctr: 8, position: 4 },
  { key: 'заказать монтаж окон цена', clicks: 80, impressions: 900, ctr: 8.8, position: 5 },
  { key: 'как помыть окна без разводов', clicks: 60, impressions: 1200, ctr: 5, position: 7 },
  { key: 'что такое стеклопакет', clicks: 40, impressions: 800, ctr: 5, position: 12 },
  { key: 'пластиковые окна рехау отзывы', clicks: 30, impressions: 600, ctr: 5, position: 10 },
  { key: 'noname', clicks: 10, impressions: 100, ctr: 10, position: 20 },
];
const brandTokens = deriveBrandTokens({ name: 'OknaPro', siteUrl: 'https://oknapro.ru' });

test('_classifyQueries добавляет intent/commercial/branded к каждой строке', () => {
  const out = _classifyQueries(rows, brandTokens);
  assert.strictEqual(out.length, rows.length);
  const buy = out.find((r) => r.key.startsWith('купить'));
  assert.strictEqual(buy.commercial, true, 'купить → commercial');
  const info = out.find((r) => r.key.startsWith('как помыть'));
  assert.strictEqual(info.intent, 'informational');
  assert.strictEqual(info.commercial, false);
  out.forEach((r) => assert.ok('branded' in r, 'есть branded'));
});

test('_splitQueries разбивает по сегментам и сортирует по кликам', () => {
  const classified = _classifyQueries(rows, brandTokens);
  const split = _splitQueries(classified);
  assert.ok(split.commercial.length >= 2, 'есть коммерческие');
  assert.ok(split.informational.length >= 1, 'есть информационные');
  // Все три массива не пересекаются
  const keys = new Set();
  [...split.commercial, ...split.informational, ...split.other].forEach((r) => {
    assert.ok(!keys.has(r.key), `query "${r.key}" встретился в нескольких сегментах`);
    keys.add(r.key);
  });
  // Сортировка по убыванию кликов
  for (let i = 1; i < split.commercial.length; i++) {
    assert.ok(split.commercial[i - 1].clicks >= split.commercial[i].clicks, 'commercial по убыванию clicks');
  }
});

test('_splitPages помечает интент страницы по URL (urlClassifier)', () => {
  const pages = [
    { key: '/catalog/okna-pvh',  clicks: 200, impressions: 3000, ctr: 6.6, position: 4 },
    { key: '/blog/kak-pomyt-okna', clicks: 100, impressions: 2500, ctr: 4, position: 8 },
    { key: '/about', clicks: 5, impressions: 50, ctr: 10, position: 15 },
  ];
  // Интент теперь по URL: /catalog/ → commercial (маркер), /blog/ → informational
  // (маркер), /about без маркеров → unknown (не удалось распознать,
  // commercial=null → попадает в оба списка отчёта).
  const queryPageMap = new Map([
    ['/catalog/okna-pvh',    { commercialClicks: 160, totalClicks: 200 }],
    ['/blog/kak-pomyt-okna', { commercialClicks: 0,   totalClicks: 100 }],
  ]);
  const tagged = _splitPages(pages, queryPageMap);
  const catalog = tagged.find((p) => p.key === '/catalog/okna-pvh');
  const blog    = tagged.find((p) => p.key === '/blog/kak-pomyt-okna');
  const about   = tagged.find((p) => p.key === '/about');
  assert.strictEqual(catalog.commercial, true);
  assert.strictEqual(catalog.page_intent, 'commercial');
  assert.strictEqual(catalog.intent_confident, true);
  assert.strictEqual(catalog.intent_unknown, false);
  assert.strictEqual(catalog.commercial_share, 0.8);
  assert.strictEqual(blog.commercial, false);
  assert.strictEqual(blog.page_intent, 'informational');
  assert.strictEqual(blog.intent_confident, true);
  assert.strictEqual(blog.intent_unknown, false);
  assert.strictEqual(blog.commercial_share, 0);
  assert.strictEqual(about.commercial, null);
  assert.strictEqual(about.page_intent, 'unknown');
  assert.strictEqual(about.intent_confident, false);
  assert.strictEqual(about.intent_unknown, true);
  assert.strictEqual(about.commercial_share, null);
});

test('_buildPagesWithQueries собирает до 50 страниц с запросами и интентом по URL', () => {
  const pages = [
    { key: '/catalog/okna-pvh', clicks: 200, impressions: 3000, ctr: 6.6, position: 4 },
    { key: '/blog/kak-pomyt-okna', clicks: 100, impressions: 2500, ctr: 4, position: 8 },
  ];
  const queryPage = [
    { query: 'купить окна пвх', page: '/catalog/okna-pvh', clicks: 120, impressions: 1500, ctr: 8, position: 4 },
    { query: 'окна пвх цена', page: '/catalog/okna-pvh', clicks: 80, impressions: 1500, ctr: 5.3, position: 4 },
    { query: 'как помыть окна', page: '/blog/kak-pomyt-okna', clicks: 100, impressions: 2500, ctr: 4, position: 8 },
  ];
  const out = _buildPagesWithQueries(pages, queryPage, 'google');
  assert.strictEqual(out.length, 2);
  assert.strictEqual(out[0].url, '/catalog/okna-pvh');
  assert.strictEqual(out[0].engine, 'google');
  assert.strictEqual(out[0].page_intent, 'commercial');
  assert.strictEqual(out[0].queries_count, 2);
  // запросы отсортированы по кликам
  assert.strictEqual(out[0].queries[0].query, 'купить окна пвх');
  assert.strictEqual(out[1].page_intent, 'informational');
  assert.strictEqual(out[1].queries_count, 1);
});

test('_summarizeCommercial возвращает абсолюты и share_pct с одним знаком', () => {
  const classified = _classifyQueries(rows, brandTokens);
  const s = _summarizeCommercial(classified);
  assert.strictEqual(s.total_clicks, 340);
  assert.ok(s.commercial_clicks >= 200, `commercial_clicks=${s.commercial_clicks}`);
  assert.ok(s.commercial_share_pct >= 50 && s.commercial_share_pct <= 100);
  // Один знак после запятой
  assert.strictEqual(Math.round(s.commercial_share_pct * 10) / 10, s.commercial_share_pct);
});

test('_summarizeCommercial безопасен на пустом массиве', () => {
  const s = _summarizeCommercial([]);
  assert.strictEqual(s.total_clicks, 0);
  assert.strictEqual(s.commercial_clicks, 0);
  assert.strictEqual(s.commercial_share_pct, null);
});

test('_buildPagesWithQueries: при unknown-URL интент фолбэком берётся из запросов', () => {
  // Страница /domain/page — без явных URL-маркеров; интент должен прийти
  // от запросов: 200 коммерческих кликов против 0 информационных → commercial.
  const pages = [{ key: '/domain/some-product', clicks: 220, impressions: 3000, ctr: 7, position: 5 }];
  const queryPage = [
    { query: 'купить some-product недорого', page: '/domain/some-product', clicks: 200, impressions: 2500, ctr: 8, position: 4 },
    { query: 'some-product отзывы', page: '/domain/some-product', clicks: 20, impressions: 500, ctr: 4, position: 9 },
  ];
  const out = _buildPagesWithQueries(pages, queryPage, 'google', brandTokens);
  assert.strictEqual(out[0].page_intent, 'commercial', 'majority-vote intent commercial');
  assert.strictEqual(out[0].intent_marker, 'queries-majority');
});

test('_buildPagesWithQueries: без запросов unknown-URL остаётся unknown', () => {
  const pages = [{ key: '/about', clicks: 5, impressions: 50, ctr: 10, position: 15 }];
  const out = _buildPagesWithQueries(pages, [], 'google', brandTokens);
  assert.strictEqual(out[0].page_intent, 'unknown');
  assert.strictEqual(out[0].intent_unknown, true);
});

test('_buildYandexQueriesAsPages: каждый запрос — псевдо-строка с интентом по запросу', () => {
  const yaQueries = [
    { key: 'купить пластиковые окна', clicks: 120, impressions: 1500, ctr: 8, position: 4 },
    { key: 'как помыть окна', clicks: 60, impressions: 1200, ctr: 5, position: 7 },
    { key: 'noname brandless', clicks: 5, impressions: 80, ctr: 6, position: 20 },
  ];
  const out = _buildYandexQueriesAsPages(yaQueries, brandTokens);
  assert.strictEqual(out.length, 3);
  // url=null, query=исходный запрос, движок 'yandex'
  assert.strictEqual(out[0].url, null);
  assert.strictEqual(out[0].query, 'купить пластиковые окна');
  assert.strictEqual(out[0].engine, 'yandex');
  assert.strictEqual(out[0].page_intent, 'commercial');
  // queries_count=0 (нечего разворачивать)
  assert.strictEqual(out[0].queries_count, 0);
  // Сортировка по убыванию кликов
  assert.ok(out[0].clicks >= out[1].clicks && out[1].clicks >= out[2].clicks);
  const info = out.find((r) => r.query.startsWith('как помыть'));
  assert.strictEqual(info.page_intent, 'informational');
});

console.log(`\n${passed} passed`);
