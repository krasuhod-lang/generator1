'use strict';

/**
 * Тесты для модуля cannibalization (сканер каннибализации).
 *
 * Не требует Postgres/сети — проверяем чистые функции:
 *   - analyzer.buildReport (пороги, транзитивные кластеры, граничные случаи)
 *   - queries.normalizeH1 / isJunkH1 / dedupe
 *   - aiExplainer._parse / _buildUser
 *
 * Запуск: node backend/scripts/test-cannibalization.js
 */

const assert = require('assert');

const analyzer = require('../src/services/cannibalization/analyzer');
const queries  = require('../src/services/cannibalization/queries');
const ai       = require('../src/services/cannibalization/aiExplainer');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✔ ${name}`); }
  catch (e) { failed++; console.log(`  ✘ ${name}\n    ${e.stack || e.message}`); }
}
function group(name, fn) { console.log(name); fn(); }

// helper: набор URL
function serp(...urls) { return urls; }

group('analyzer.buildReport — базовые пороги', () => {
  test('пара с >= minCommonUrls конфликтна и образует кластер', () => {
    const q = [
      { query: 'купить окна', source_url: 'https://site.ru/okna', urls:
        serp('https://a.ru/1','https://a.ru/2','https://a.ru/3','https://a.ru/4','https://x.ru/9') },
      { query: 'пластиковые окна', source_url: 'https://site.ru/plastikovye-okna', urls:
        serp('https://a.ru/1','https://a.ru/2','https://a.ru/3','https://a.ru/4','https://y.ru/8') },
    ];
    const r = analyzer.buildReport(q, { minCommonUrls: 4, topN: 10 });
    assert.strictEqual(r.summary.totalQueries, 2);
    assert.strictEqual(r.summary.conflictPairs, 1);
    assert.strictEqual(r.clusters.length, 1);
    assert.strictEqual(r.clusters[0].size, 2);
    assert.strictEqual(r.summary.pagesToMerge, 2);
  });

  test('общих URL меньше порога — нет кластера', () => {
    const q = [
      { query: 'a', source_url: 'u1', urls: serp('1','2','3','9') },
      { query: 'b', source_url: 'u2', urls: serp('1','2','3','8') }, // 3 общих < 4
    ];
    const r = analyzer.buildReport(q, { minCommonUrls: 4 });
    assert.strictEqual(r.summary.conflictPairs, 0);
    assert.strictEqual(r.clusters.length, 0);
    // но в матрице пара с common>0 присутствует
    assert.strictEqual(r.matrix.length, 1);
    assert.strictEqual(r.matrix[0].common, 3);
  });

  test('настраиваемый порог = 3 делает ту же пару конфликтной', () => {
    const q = [
      { query: 'a', source_url: 'u1', urls: serp('1','2','3','9') },
      { query: 'b', source_url: 'u2', urls: serp('1','2','3','8') },
    ];
    const r = analyzer.buildReport(q, { minCommonUrls: 3 });
    assert.strictEqual(r.clusters.length, 1);
  });
});

group('analyzer.buildReport — транзитивные кластеры', () => {
  test('A~B, B~C → один кластер из 3', () => {
    const shared = serp('1','2','3','4');
    const q = [
      { query: 'A', source_url: 'a', urls: shared.concat('x1') },
      { query: 'B', source_url: 'b', urls: shared.concat('x2') },
      { query: 'C', source_url: 'c', urls: shared.concat('x3') },
    ];
    const r = analyzer.buildReport(q, { minCommonUrls: 4 });
    assert.strictEqual(r.clusters.length, 1);
    assert.strictEqual(r.clusters[0].size, 3);
    assert.strictEqual(r.summary.pagesToMerge, 3);
  });

  test('две независимые пары → два кластера', () => {
    const s1 = serp('1','2','3','4');
    const s2 = serp('a','b','c','d');
    const q = [
      { query: 'A', source_url: 'a', urls: s1.concat('z1') },
      { query: 'B', source_url: 'b', urls: s1.concat('z2') },
      { query: 'C', source_url: 'c', urls: s2.concat('z3') },
      { query: 'D', source_url: 'd', urls: s2.concat('z4') },
    ];
    const r = analyzer.buildReport(q, { minCommonUrls: 4 });
    assert.strictEqual(r.clusters.length, 2);
  });
});

group('analyzer.buildReport — граничные случаи', () => {
  test('0 запросов', () => {
    const r = analyzer.buildReport([], { minCommonUrls: 4 });
    assert.strictEqual(r.summary.totalQueries, 0);
    assert.strictEqual(r.clusters.length, 0);
    assert.strictEqual(r.summary.comparedPairs, 0);
  });

  test('1 запрос — не с чем сравнивать', () => {
    const r = analyzer.buildReport([{ query: 'a', source_url: 'u', urls: serp('1','2') }], {});
    assert.strictEqual(r.summary.totalQueries, 1);
    assert.strictEqual(r.summary.comparedPairs, 0);
    assert.strictEqual(r.clusters.length, 0);
  });

  test('запрос с пустым набором URL отбрасывается', () => {
    const r = analyzer.buildReport([
      { query: 'a', source_url: 'u', urls: [] },
      { query: 'b', source_url: 'u2', urls: serp('1') },
    ], {});
    assert.strictEqual(r.summary.totalQueries, 1);
  });

  test('полностью совпадающие выдачи', () => {
    const s = serp('1','2','3','4','5');
    const r = analyzer.buildReport([
      { query: 'a', source_url: 'ua', urls: s },
      { query: 'b', source_url: 'ub', urls: s },
    ], { minCommonUrls: 4 });
    assert.strictEqual(r.clusters.length, 1);
    assert.strictEqual(r.clusters[0].maxCommon, 5);
  });

  test('дедуп URL внутри одной выдачи и усечение до topN', () => {
    const r = analyzer.buildReport([
      { query: 'a', source_url: 'ua', urls: serp('1','1','2','3','4','5') },
    ], { topN: 3 });
    assert.strictEqual(r.queries[0].urlCount, 3); // 1,2,3
  });
});

group('analyzer.buildReport — свой домен в топе', () => {
  test('ownDomain встречается 2+ раз — попадает в ownDomainDuplicates', () => {
    const r = analyzer.buildReport([
      { query: 'a', source_url: 'https://site.ru/x', urls:
        serp('https://site.ru/x','https://site.ru/y','https://other.ru/1') },
    ], { ownDomain: 'https://site.ru/x' });
    assert.strictEqual(r.ownDomainDuplicates.length, 1);
    assert.strictEqual(r.queries[0].ownDomainCount, 2);
  });

  test('www нормализуется при сравнении домена', () => {
    const r = analyzer.buildReport([
      { query: 'a', source_url: 'https://site.ru/x', urls:
        serp('https://www.site.ru/x','https://site.ru/y') },
    ], { ownDomain: 'site.ru' });
    assert.strictEqual(r.ownDomainDuplicates.length, 1);
  });
});

group('queries helpers', () => {
  test('normalizeH1 collapses whitespace', () => {
    assert.strictEqual(queries.normalizeH1('  купить   окна\n'), 'купить окна');
  });
  test('isJunkH1 отсекает мусор', () => {
    assert.ok(queries.isJunkH1(''));
    assert.ok(queries.isJunkH1('404'));
    assert.ok(queries.isJunkH1('Корзина'));
    assert.ok(queries.isJunkH1('12345'));
    assert.ok(!queries.isJunkH1('пластиковые окна'));
  });
  test('dedupe объединяет одинаковые H1 и копит dup_urls', () => {
    const { queries: q, duplicates, skipped } = queries.dedupe([
      { url: 'https://s.ru/a', h1: 'Окна' },
      { url: 'https://s.ru/b', h1: 'окна' },        // тот же H1 (case-insensitive)
      { url: 'https://s.ru/c', h1: '404' },         // junk
      { url: 'https://s.ru/d', h1: 'Двери' },
    ]);
    assert.strictEqual(q.length, 2);               // Окна + Двери
    assert.strictEqual(duplicates, 1);             // Окна дублируется
    assert.strictEqual(skipped, 1);                // 404
    const okna = q.find((x) => x.query === 'Окна');
    assert.deepStrictEqual(okna.dup_urls, ['https://s.ru/b']);
  });
  test('dedupe уважает maxQueries', () => {
    const pages = [];
    for (let i = 0; i < 10; i++) pages.push({ url: `u${i}`, h1: `запрос ${i}` });
    const { queries: q, truncated } = queries.dedupe(pages, { maxQueries: 3 });
    assert.strictEqual(q.length, 3);
    assert.ok(truncated);
  });
});

group('aiExplainer helpers', () => {
  test('_parse извлекает JSON-массив из ответа', () => {
    const arr = ai._parse('тут ответ [{"cluster_id":1,"keep":"a","merge":["b"],"reason":"r"}] конец');
    assert.ok(Array.isArray(arr));
    assert.strictEqual(arr[0].cluster_id, 1);
  });
  test('_parse на мусоре возвращает null', () => {
    assert.strictEqual(ai._parse('no json here'), null);
  });
  test('_buildUser содержит текущий год и запросы', () => {
    const u = ai._buildUser([{ id: 1, maxCommon: 4, members: [{ query: 'окна', source_url: 'u' }] }]);
    assert.ok(u.includes(String(new Date().getFullYear())));
    assert.ok(u.includes('окна'));
  });
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
