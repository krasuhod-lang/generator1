'use strict';

/* Tests for reports/dataCache — TTL, dedup, prefix invalidation. */

const assert = require('assert');
const cache = require('../src/services/reports/dataCache');

let passed = 0; let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ok  -', name); })
    .catch((e) => { failed++; console.log('FAIL  -', name, '\n        ', e.message); });
}

(async () => {
  // ── makeKey: стабильный порядок ключей объектов ──
  await test('makeKey: stable ordering for objects', () => {
    const k1 = cache.makeKey(['x', { a: 1, b: 2 }]);
    const k2 = cache.makeKey(['x', { b: 2, a: 1 }]);
    assert.strictEqual(k1, k2);
  });

  // ── read-through: один и тот же ключ дёргает loader один раз ──
  await test('cached: dedup parallel loaders for same key', async () => {
    cache.clear();
    let calls = 0;
    const loader = () => { calls += 1; return new Promise((r) => setTimeout(() => r({ ok: 1 }), 30)); };
    const [a, b, c] = await Promise.all([
      cache.cached('k:dedup', loader),
      cache.cached('k:dedup', loader),
      cache.cached('k:dedup', loader),
    ]);
    assert.strictEqual(calls, 1, 'loader должен вызваться один раз');
    assert.strictEqual(a, b); assert.strictEqual(b, c);
    assert.deepStrictEqual(a, { ok: 1 });
  });

  // ── после reject запись чистится — следующий вызов идёт заново ──
  await test('cached: reject evicts entry so next call retries', async () => {
    cache.clear();
    let calls = 0;
    const loader = () => { calls += 1; return Promise.reject(new Error('boom')); };
    await assert.rejects(cache.cached('k:err', loader));
    await assert.rejects(cache.cached('k:err', loader));
    assert.strictEqual(calls, 2, 'каждый вызов должен идти за свежими данными после ошибки');
  });

  // ── prefix invalidation ──
  await test('invalidatePrefix: drops only matching keys', async () => {
    cache.clear();
    await cache.cached('reports:section|gsc|1|2024-01-01|2024-01-31|day', () => Promise.resolve(1));
    await cache.cached('reports:section|gsc|2|2024-01-01|2024-01-31|day', () => Promise.resolve(2));
    await cache.cached('reports:section|ywm|1|2024-01-01|2024-01-31|day', () => Promise.resolve(3));
    const before = cache.size();
    assert.strictEqual(before, 3);
    const n = cache.invalidatePrefix('reports:section|gsc|1|');
    assert.strictEqual(n, 1);
    assert.strictEqual(cache.size(), 2);
  });

  // ── TTL=0 отключает кэш ──
  await test('cached: ttl=0 bypasses cache', async () => {
    cache.clear();
    let calls = 0;
    const loader = () => { calls += 1; return Promise.resolve('v'); };
    await cache.cached('k:nottl', loader, 0);
    await cache.cached('k:nottl', loader, 0);
    assert.strictEqual(calls, 2);
    assert.strictEqual(cache.size(), 0);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
