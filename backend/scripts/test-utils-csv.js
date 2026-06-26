'use strict';

/* Tests for utils/csv — sep directive, escaping, injection guard. */

const assert = require('assert');
const { csvCell, csvHeader } = require('../src/utils/csv');

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n        ', e.message); }
}

test('csvHeader: BOM + sep directive (Excel-EN / Sheets fix)', () => {
  const h = csvHeader(';');
  assert.strictEqual(h, '\uFEFFsep=;\r\n');
});

test('csvHeader: custom separator', () => {
  assert.strictEqual(csvHeader(','), '\uFEFFsep=,\r\n');
});

test('csvCell: wraps in quotes and doubles internal quotes', () => {
  assert.strictEqual(csvCell('hello "world"'), '"hello ""world"""');
});

test('csvCell: null/undefined → empty quoted', () => {
  assert.strictEqual(csvCell(null), '""');
  assert.strictEqual(csvCell(undefined), '""');
});

test('csvCell: CRLF replaced with space (не ломает строки)', () => {
  assert.strictEqual(csvCell('a\r\nb\nc'), '"a b c"');
});

test('csvCell: CSV-injection guard (=+-@) prefixed with apostrophe', () => {
  assert.strictEqual(csvCell('=SUM(A1:A2)'), '"\'=SUM(A1:A2)"');
  assert.strictEqual(csvCell('+1234'), '"\'+1234"');
  assert.strictEqual(csvCell('-1.5'), '"\'-1.5"');
  assert.strictEqual(csvCell('@cmd'), '"\'@cmd"');
});

test('csvCell: semicolon inside value safe (quoted)', () => {
  assert.strictEqual(csvCell('a;b;c'), '"a;b;c"');
});

test('csvCell: numbers stringified', () => {
  assert.strictEqual(csvCell(0), '"0"');
  assert.strictEqual(csvCell(42), '"42"');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
