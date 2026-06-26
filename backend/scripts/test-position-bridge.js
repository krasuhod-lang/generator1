'use strict';

/**
 * Smoke-tests for positionBridge geo resolution + updateLinkedPositionSettings.
 *
 *  • resolveGeoFromProject: pulls geo_lr/geo_loc from project.keys_so_region
 *    (and respects explicit opts.geo_lr / opts.geo_loc overrides).
 *  • ensureLinkedPositionProject: pure logic checked indirectly via DB stub —
 *    мы проверяем только pure-функцию geo-резолвера; работа с pg-pool
 *    инкапсулирована в integration-тестах.
 *
 * Запуск:  node backend/scripts/test-position-bridge.js
 */

const assert = require('assert');
const {
  resolveGeoFromProject,
  KEYS_SO_REGION_TO_LR,
  KEYS_SO_REGION_TO_LOC,
} = require('../src/services/projects/positionBridge');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`✓ ${name}`); passed += 1; }
  catch (err) { console.error(`✗ ${name}\n  ${err.message}`); failed += 1; }
}

test('region maps cover canonical KEYS_SO codes', () => {
  // Moscow and Saint-Petersburg are the most important defaults.
  assert.strictEqual(KEYS_SO_REGION_TO_LR.msk, '213');
  assert.strictEqual(KEYS_SO_REGION_TO_LR.spb, '2');
  assert.ok(KEYS_SO_REGION_TO_LR.ekb, 'ekb should be in LR map');
  assert.ok(KEYS_SO_REGION_TO_LOC.msk, 'msk should have Google location id');
  assert.ok(KEYS_SO_REGION_TO_LOC.spb, 'spb should have Google location id');
});

test('resolveGeoFromProject: keys_so_region=msk → geo_lr=213', () => {
  const r = resolveGeoFromProject({ keys_so_region: 'msk' });
  assert.strictEqual(r.geo_lr, '213');
  assert.ok(r.geo_loc.length > 0, 'geo_loc should be set for msk');
});

test('resolveGeoFromProject: explicit opts win over project region', () => {
  const r = resolveGeoFromProject(
    { keys_so_region: 'msk' },
    { geo_lr: '11023', geo_loc: 'custom-loc' },
  );
  assert.strictEqual(r.geo_lr, '11023');
  assert.strictEqual(r.geo_loc, 'custom-loc');
});

test('resolveGeoFromProject: unknown region → empty strings (no crash)', () => {
  const r = resolveGeoFromProject({ keys_so_region: 'unknown_xyz' });
  assert.strictEqual(r.geo_lr, '');
  assert.strictEqual(r.geo_loc, '');
});

test('resolveGeoFromProject: null/undefined project safe', () => {
  const r1 = resolveGeoFromProject(null);
  const r2 = resolveGeoFromProject(undefined);
  const r3 = resolveGeoFromProject({});
  assert.strictEqual(r1.geo_lr, '');
  assert.strictEqual(r2.geo_loc, '');
  assert.strictEqual(r3.geo_lr, '');
});

test('resolveGeoFromProject: case-insensitive region', () => {
  const r = resolveGeoFromProject({ keys_so_region: 'MSK' });
  assert.strictEqual(r.geo_lr, '213');
});

test('resolveGeoFromProject: geo_lr truncated to 16 chars', () => {
  const longLr = '1'.repeat(50);
  const r = resolveGeoFromProject({}, { geo_lr: longLr });
  assert.ok(r.geo_lr.length <= 16, `got length=${r.geo_lr.length}`);
});

test('resolveGeoFromProject: geo_loc truncated to 200 chars', () => {
  const longLoc = 'x'.repeat(500);
  const r = resolveGeoFromProject({}, { geo_loc: longLoc });
  assert.ok(r.geo_loc.length <= 200, `got length=${r.geo_loc.length}`);
});

test('resolveGeoFromProject: spb → lr=2, loc populated', () => {
  const r = resolveGeoFromProject({ keys_so_region: 'spb' });
  assert.strictEqual(r.geo_lr, '2');
  assert.ok(r.geo_loc, 'spb should have geo_loc');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
