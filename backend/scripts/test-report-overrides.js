'use strict';

/**
 * Тесты overridesApplier (ТЗ §6): применение dot-path правок к payload отчёта.
 *
 * Покрывают:
 *  - parsePath: валидные пути с точками и [N], отказ на запрещённых ключах
 *  - applyOverrides: установка значений по существующим и новым путям
 *  - applyOverrides: индексы массивов, создание промежуточных узлов
 *  - applyOverrides: устойчивость к prototype-pollution
 *  - deepMerge: sentinel-удаление через null/undefined
 *  - _overrides бейджи проставляются на затронутых родителях
 */

const assert = require('assert');
const { applyOverrides, deepMerge, parsePath } = require('../src/services/reports/overridesApplier');

let passed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}\n      ${e.message}`); process.exitCode = 1; }
}

test('parsePath: "a.b.c"', () => {
  assert.deepStrictEqual(parsePath('a.b.c'), ['a', 'b', 'c']);
});

test('parsePath: "a.b[2].c"', () => {
  assert.deepStrictEqual(parsePath('a.b[2].c'), ['a', 'b', 2, 'c']);
});

test('parsePath: пустой/невалидный → null', () => {
  assert.strictEqual(parsePath(''), null);
  assert.strictEqual(parsePath('.'), null);
  assert.strictEqual(parsePath('a..b'), null);
  assert.strictEqual(parsePath('__proto__.polluted'), null);
});

test('applyOverrides: правка существующего поля', () => {
  const data = { gsc: { totals: { clicks: 100 } } };
  applyOverrides(data, { 'gsc.totals.clicks': 12345 });
  assert.strictEqual(data.gsc.totals.clicks, 12345);
  assert.deepStrictEqual(data.gsc.totals._overrides, ['clicks']);
});

test('applyOverrides: правка элемента массива по индексу', () => {
  const data = { queries: { top_queries_commercial: [
    { key: 'a', position: 10 }, { key: 'b', position: 11 },
  ] } };
  applyOverrides(data, { 'queries.top_queries_commercial[0].position': 4.2 });
  assert.strictEqual(data.queries.top_queries_commercial[0].position, 4.2);
  assert.strictEqual(data.queries.top_queries_commercial[1].position, 11);
  assert.deepStrictEqual(data.queries.top_queries_commercial[0]._overrides, ['position']);
});

test('applyOverrides: создание промежуточных объектов', () => {
  const data = {};
  applyOverrides(data, { 'summary.executive_summary': 'Правленый текст' });
  assert.strictEqual(data.summary.executive_summary, 'Правленый текст');
});

test('applyOverrides: prototype-pollution не проходит', () => {
  const data = {};
  applyOverrides(data, { '__proto__.polluted': true, 'constructor.bad': 1 });
  assert.strictEqual({}.polluted, undefined, 'Object.prototype не загрязнён');
});

test('applyOverrides: несколько правок в одном вызове', () => {
  const data = { gsc: { totals: { clicks: 1, impressions: 2 } } };
  applyOverrides(data, {
    'gsc.totals.clicks': 10,
    'gsc.totals.impressions': 20,
  });
  assert.strictEqual(data.gsc.totals.clicks, 10);
  assert.strictEqual(data.gsc.totals.impressions, 20);
  assert.deepStrictEqual(data.gsc.totals._overrides.sort(), ['clicks', 'impressions'].sort());
});

test('applyOverrides: невалидный путь молча пропускается', () => {
  const data = { a: 1 };
  // Не должен бросить
  applyOverrides(data, { 'bad..path': 99, 'a.b.c': 5 });
  // Валидный применился
  assert.strictEqual(data.a.b.c, 5);
});

test('deepMerge: добавление и обновление', () => {
  const out = deepMerge({ 'a': 1, 'b': 2 }, { 'b': 20, 'c': 30 });
  assert.deepStrictEqual(out, { a: 1, b: 20, c: 30 });
});

test('deepMerge: null/undefined удаляет ключ', () => {
  const out = deepMerge({ 'a': 1, 'b': 2, 'c': 3 }, { 'b': null, 'c': undefined });
  assert.deepStrictEqual(out, { a: 1 });
});

test('deepMerge: безопасен на null existing', () => {
  const out = deepMerge(null, { 'a': 1 });
  assert.deepStrictEqual(out, { a: 1 });
});

console.log(`\n${passed} passed`);
