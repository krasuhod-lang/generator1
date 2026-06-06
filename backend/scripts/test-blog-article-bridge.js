'use strict';

/* Smoke-тесты детерминированных хелперов projects/blogArticleBridge (ТЗ п.7). */

const assert = require('assert');
const { _projectSiteUrl } = require('../src/services/projects/blogArticleBridge');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  -', name); }
  catch (e) { failed++; console.log('FAIL  -', name, '\n        ', e.message); }
}

test('uses project.url first', () => {
  assert.strictEqual(_projectSiteUrl({ url: 'https://example.com/' }), 'https://example.com/');
});

test('adds https when scheme missing', () => {
  assert.strictEqual(_projectSiteUrl({ url: 'example.com' }), 'https://example.com/');
});

test('converts sc-domain gsc property', () => {
  assert.strictEqual(_projectSiteUrl({ gsc_site_url: 'sc-domain:example.com' }), 'https://example.com/');
});

test('falls back to gsc then ydx site url', () => {
  assert.strictEqual(_projectSiteUrl({ gsc_site_url: 'https://g.example/' }), 'https://g.example/');
  assert.strictEqual(_projectSiteUrl({ ydx_site_url: 'https://y.example/' }), 'https://y.example/');
});

test('empty when nothing usable', () => {
  assert.strictEqual(_projectSiteUrl({}), '');
  assert.strictEqual(_projectSiteUrl({ url: '   ' }), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
