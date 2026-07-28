'use strict';

/**
 * Smoke-tests защиты отчёта релевантности от NUL (`\u0000`) и непарных
 * суррогатов.
 *
 * Проблема: Postgres не хранит NUL ни в `text`, ни в `jsonb` и падает с
 * «unsupported Unicode escape sequence» (SQLSTATE 22P05) на касте
 * JSON → jsonb. Одна страница конкурента с нулевыми байтами (кривой charset,
 * UTF-16, бинарь под видом HTML) роняла сохранение уже посчитанного отчёта —
 * оператор видел «⚠ Ошибка обработки» после полного прогона SERP + парсинга.
 *
 * Покрывает:
 *   • pageFetcher._stripControlChars — вырезание C0 из скачанного HTML;
 *   • pipeline._toJsonbParam — NUL/суррогаты в значениях и в ключах;
 *   • сохранность полезного контента (кириллица, эмодзи, \t \n \r, литерал
 *     «\u0000» внутри текста).
 *
 * Запуск:  node backend/scripts/test-relevance-nul-sanitize.js
 */

const assert = require('assert');

// db мокаем на уровне модуля — pipeline тянет config/db при require.
require.cache[require.resolve('../src/config/db')] = {
  exports: { query: async () => ({ rows: [], rowCount: 0 }), getClient: async () => ({ release() {} }) },
};

const pageFetcher = require('../src/services/relevance/pageFetcher');
const pipeline    = require('../src/services/relevance/pipeline');

const { _stripControlChars } = pageFetcher;
const { _toJsonbParam }      = pipeline;

let failures = 0;
function ok(name, cond) {
  if (cond) { console.log(`  ✓ ${name}`); } else { console.log(`  ✗ ${name}`); failures += 1; }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[relevance] pageFetcher._stripControlChars — HTML на входе');

ok('NUL вырезан', _stripControlChars('<p>прив\u0000ет</p>') === '<p>привет</p>');
ok(
  'UTF-16-подобный мусор склеивается обратно в слово',
  _stripControlChars('h\u0000e\u0000l\u0000l\u0000o\u0000') === 'hello',
);
ok(
  'прочие C0 вырезаны',
  _stripControlChars('a\u0001b\u0008c\u000Bd\u000Ce\u001Ff') === 'abcdef',
);
ok(
  '\\t \\n \\r сохранены (значимы для парсера)',
  _stripControlChars('<div>a\tb\nc\r\nd</div>') === '<div>a\tb\nc\r\nd</div>',
);
ok(
  'чистый HTML не меняется (кириллица + эмодзи)',
  _stripControlChars('<h1>Купить окна 🚀</h1>') === '<h1>Купить окна 🚀</h1>',
);
ok('нестроки проходят насквозь', _stripControlChars(null) === null && _stripControlChars('') === '');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[relevance] pipeline._toJsonbParam — параметр для ::jsonb');

const withNul = _toJsonbParam({
  query: 'окна',
  document_diagnostics: [{ url: 'https://a.ru', parsed_preview: 'текст\u0000ещё' }],
});
ok('в результате нет escape \\u0000', !/\\u0000/.test(withNul));
ok('результат — валидный JSON', (() => { try { JSON.parse(withNul); return true; } catch (_) { return false; } })());
ok(
  'полезный текст сохранён',
  JSON.parse(withNul).document_diagnostics[0].parsed_preview === 'текстещё',
);

const withNulKey = _toJsonbParam({ ['bad\u0000key']: 1, good: 2 });
ok('NUL в ключе объекта тоже вычищен', !/\\u0000/.test(withNulKey));
ok('объект с NUL-ключом парсится', (() => {
  try { return JSON.parse(withNulKey).good === 2; } catch (_) { return false; }
})());

const literal = _toJsonbParam({ code: 'if (c === "\\u0000") return;' });
ok('литеральный текст «\\u0000» не ломает JSON', (() => {
  try { return JSON.parse(literal).code === 'if (c === "\\u0000") return;'; } catch (_) { return false; }
})());

// Непарный суррогат появляется, например, при .slice() ровно по середине эмодзи.
const cutEmoji = '🚀'.slice(0, 1);
const withSurrogate = _toJsonbParam([{ url: 'https://a.ru', title: `Окна ${cutEmoji}` }]);
ok('одиночный суррогат вырезан', !/\\ud[89ab][0-9a-f]{2}/i.test(withSurrogate));
ok('после вырезания суррогата JSON валиден', (() => {
  try { return JSON.parse(withSurrogate)[0].title === 'Окна '; } catch (_) { return false; }
})());

const pairKept = _toJsonbParam({ title: 'Окна 🚀 дёшево' });
ok('валидная суррогатная пара (эмодзи) сохранена', JSON.parse(pairKept).title === 'Окна 🚀 дёшево');

ok('null/undefined → null (колонка остаётся NULL)',
  _toJsonbParam(null) === null && _toJsonbParam(undefined) === null);
ok('обычный отчёт сериализуется как раньше',
  _toJsonbParam({ a: 1, b: ['x', null] }) === JSON.stringify({ a: 1, b: ['x', null] }));

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n[relevance] сквозной сценарий: HTML с NUL → отчёт → jsonb');

const dirtyHtml = '<html><body><h1>Пласт\u0000иковые окна</h1></body></html>';
const cleanHtml = _stripControlChars(dirtyHtml);
const reportParam = _toJsonbParam({
  query: 'пластиковые окна',
  document_diagnostics: [{ url: 'https://a.ru', parsed_preview: cleanHtml }],
});
ok('после обеих стадий escape \\u0000 отсутствует', !/\\u0000/.test(reportParam));
assert.doesNotThrow(() => JSON.parse(reportParam));
ok('слово не потеряло символы', JSON.parse(reportParam)
  .document_diagnostics[0].parsed_preview.includes('Пластиковые окна'));

// ─────────────────────────────────────────────────────────────────────────────
console.log(failures === 0 ? '\n✅ Все проверки пройдены\n' : `\n❌ Провалено проверок: ${failures}\n`);
process.exit(failures === 0 ? 0 : 1);
