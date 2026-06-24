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

test('_splitPages помечает страницу commercial если ≥50% commercial-кликов', () => {
  const pages = [
    { key: '/catalog/okna-pvh',  clicks: 200, impressions: 3000, ctr: 6.6, position: 4 },
    { key: '/blog/kak-pomyt-okna', clicks: 100, impressions: 2500, ctr: 4, position: 8 },
    { key: '/about', clicks: 5, impressions: 50, ctr: 10, position: 15 },
  ];
  // 80% кликов /catalog/okna-pvh — commercial; 100% /blog — informational;
  // /about без покрытия в queryPageMap → commercial_share=null, не попадает ни в один сегмент.
  const queryPageMap = new Map([
    ['/catalog/okna-pvh',    { commercialClicks: 160, totalClicks: 200 }],
    ['/blog/kak-pomyt-okna', { commercialClicks: 0,   totalClicks: 100 }],
  ]);
  const tagged = _splitPages(pages, queryPageMap);
  const catalog = tagged.find((p) => p.key === '/catalog/okna-pvh');
  const blog    = tagged.find((p) => p.key === '/blog/kak-pomyt-okna');
  const about   = tagged.find((p) => p.key === '/about');
  assert.strictEqual(catalog.commercial, true);
  assert.strictEqual(catalog.commercial_share, 0.8);
  assert.strictEqual(blog.commercial, false);
  assert.strictEqual(blog.commercial_share, 0);
  assert.strictEqual(about.commercial, false);
  assert.strictEqual(about.commercial_share, null);
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

console.log(`\n${passed} passed`);
