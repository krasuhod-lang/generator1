'use strict';

/**
 * test-works-service.js — юнит-тесты PR-5 Works Log Module
 * (worksService.sanitizeWorkForMode + проверка наличия экспортов).
 *
 * Запуск:  node backend/scripts/test-works-service.js
 *
 * БД-зависимая логика (list/create/update/delete) проверяется интеграционно
 * на дев-стенде; в этом скрипте — только pure-функция санитизации, чтобы
 * она надёжно прятала технические поля от клиента, гарантия PR-2.
 */

const assert = require('assert');

// worksService подтягивает '../../config/db', которая в свою очередь подключается
// к Postgres при require(). Чтобы юнит-тест не требовал БД, подставим заглушку
// в Node module cache до require('worksService').
const path = require('path');
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && /worksService\.js$/.test(parent.filename || '') && request === '../../config/db') {
    const fakePath = path.resolve(__dirname, '__db_stub.js');
    if (!require.cache[fakePath]) {
      require.cache[fakePath] = {
        id: fakePath, filename: fakePath, loaded: true, exports: { query: async () => ({ rows: [] }) },
      };
    }
    return fakePath;
  }
  return origResolve.call(this, request, parent, ...rest);
};

const ws = require('../src/services/projects/worksService');

let total = 0, failed = 0;
function test(name, fn) {
  total += 1;
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('── sanitizeWorkForMode ─────────────────────────');

const SAMPLE = Object.freeze({
  id: 'w1',
  project_id: 'p1',
  performed_at: '2026-06-01T12:00:00Z',
  type: 'tech',
  status: 'done',
  title: 'Внедрили sitemap.xml',
  description: 'Сгенерировали XML, добавили lastmod, отправили в GSC',
  client_summary: 'Поисковики стали быстрее находить новые страницы',
  impact: { queries_top10: 12 },
  links: [{ label: 'PR', url: 'https://github.com/x/y/pull/1' }],
});

test('analyst mode returns all fields untouched', () => {
  const out = ws.sanitizeWorkForMode(SAMPLE, 'analyst');
  assert.strictEqual(out.description, SAMPLE.description);
  assert.deepStrictEqual(out.impact, SAMPLE.impact);
  assert.strictEqual(out.client_summary, SAMPLE.client_summary);
});

test('client mode strips description', () => {
  const out = ws.sanitizeWorkForMode(SAMPLE, 'client');
  assert.strictEqual(out.description, undefined);
});

test('client mode strips impact', () => {
  const out = ws.sanitizeWorkForMode(SAMPLE, 'client');
  assert.strictEqual(out.impact, undefined);
});

test('client mode preserves client_summary and title', () => {
  const out = ws.sanitizeWorkForMode(SAMPLE, 'client');
  assert.strictEqual(out.client_summary, SAMPLE.client_summary);
  assert.strictEqual(out.title, SAMPLE.title);
});

test('client mode preserves performed_at, type, status, links', () => {
  const out = ws.sanitizeWorkForMode(SAMPLE, 'client');
  assert.strictEqual(out.performed_at, SAMPLE.performed_at);
  assert.strictEqual(out.type, SAMPLE.type);
  assert.strictEqual(out.status, SAMPLE.status);
  assert.deepStrictEqual(out.links, SAMPLE.links);
});

test('client mode falls back to title when client_summary missing', () => {
  const row = { ...SAMPLE, client_summary: null };
  const out = ws.sanitizeWorkForMode(row, 'client');
  assert.strictEqual(out.client_summary, SAMPLE.title);
});

test('client mode never mutates input object', () => {
  const row = { ...SAMPLE };
  ws.sanitizeWorkForMode(row, 'client');
  assert.strictEqual(row.description, SAMPLE.description);
  assert.deepStrictEqual(row.impact, SAMPLE.impact);
});

test('null input returns null', () => {
  assert.strictEqual(ws.sanitizeWorkForMode(null, 'client'), null);
});

test('non-object input returned as-is', () => {
  assert.strictEqual(ws.sanitizeWorkForMode('x', 'client'), 'x');
});

console.log('── exports surface ────────────────────────────');
test('module exports listWorks/createWork/updateWork/deleteWork', () => {
  assert.strictEqual(typeof ws.listWorks, 'function');
  assert.strictEqual(typeof ws.createWork, 'function');
  assert.strictEqual(typeof ws.updateWork, 'function');
  assert.strictEqual(typeof ws.deleteWork, 'function');
});

test('VALID_STATUSES is frozen array', () => {
  assert.ok(Array.isArray(ws.VALID_STATUSES));
  assert.deepStrictEqual([...ws.VALID_STATUSES].sort(), ['done', 'in_progress', 'planned']);
});

// ── 083_works_client_visible (Sprint 3) ────────────────────────────────────
console.log('── client_visible flag ────────────────────────');

test('client mode strips client_visible flag (technical-only field)', () => {
  const row = { ...SAMPLE, client_visible: true };
  const out = ws.sanitizeWorkForMode(row, 'client');
  assert.strictEqual(out.client_visible, undefined);
});

test('analyst mode keeps client_visible flag (used in management UI)', () => {
  const row = { ...SAMPLE, client_visible: false };
  const out = ws.sanitizeWorkForMode(row, 'analyst');
  assert.strictEqual(out.client_visible, false);
});

console.log('\nFinished: ' + (total - failed) + '/' + total + ' OK' + (failed ? `, ${failed} FAILED` : ''));
process.exit(failed ? 1 : 0);
