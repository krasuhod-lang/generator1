'use strict';

/**
 * Smoke-тест универсального кэша срезов (п.6 ТЗ). Детерминированный, с мок-БД.
 * Запуск: node backend/scripts/test-signal-cache.js
 */

const assert = require('assert');
const { computeHash, getOrCompute, readSignal, writeSignal } = require('../src/services/projects/signalCache');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

// Мини-мок pg: хранит по (project_id, signal_key), отдаёт row при SELECT.
function makeFakeDb() {
  const store = new Map();
  return {
    calls: { select: 0, insert: 0 },
    async query(sql, params) {
      if (/^\s*SELECT/i.test(sql)) {
        this.calls.select += 1;
        const [projectId, signalKey, hash] = params;
        const row = store.get(`${projectId}:${signalKey}`);
        if (row && row.hash === hash) {
          return { rows: [{ payload: row.payload, computed_at: new Date().toISOString(), ttl_sec: row.ttl_sec }] };
        }
        return { rows: [] };
      }
      if (/INSERT INTO project_signal_cache/i.test(sql)) {
        this.calls.insert += 1;
        const [projectId, signalKey, hash, json, ttlSec] = params;
        store.set(`${projectId}:${signalKey}`, { hash, payload: JSON.parse(json), ttl_sec: ttlSec });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

(async () => {
  // ── computeHash ───────────────────────────────────────────────────
  await test('computeHash is stable regardless of key order', () => {
    const a = computeHash({ b: 1, a: [1, 2, { x: 1, y: 2 }] });
    const b = computeHash({ a: [1, 2, { y: 2, x: 1 }], b: 1 });
    assert.strictEqual(a, b);
  });

  await test('computeHash differs for different input', () => {
    assert.notStrictEqual(computeHash({ a: 1 }), computeHash({ a: 2 }));
  });

  // ── getOrCompute: miss → compute → hit ────────────────────────────
  await test('getOrCompute computes on miss and caches on hit', async () => {
    const db = makeFakeDb();
    let computeCount = 0;
    const args = {
      projectId: 'p1', signalKey: 'eat', fingerprint: { range: '28d' },
      computeFn: async () => { computeCount += 1; return { score: 42 }; },
    };
    const first = await getOrCompute(args, db);
    assert.strictEqual(first.cached, false);
    assert.deepStrictEqual(first.payload, { score: 42 });

    const second = await getOrCompute(args, db);
    assert.strictEqual(second.cached, true);
    assert.deepStrictEqual(second.payload, { score: 42 });
    assert.strictEqual(computeCount, 1, 'compute should run once');
  });

  // ── different fingerprint invalidates cache ───────────────────────
  await test('getOrCompute recomputes when fingerprint changes', async () => {
    const db = makeFakeDb();
    let computeCount = 0;
    const base = { projectId: 'p2', signalKey: 'schema', computeFn: async () => { computeCount += 1; return computeCount; } };
    await getOrCompute({ ...base, fingerprint: { v: 1 } }, db);
    await getOrCompute({ ...base, fingerprint: { v: 2 } }, db);
    assert.strictEqual(computeCount, 2);
  });

  // ── writeSignal/readSignal round trip ─────────────────────────────
  await test('writeSignal + readSignal round trip', async () => {
    const db = makeFakeDb();
    const hash = computeHash({ a: 1 });
    await writeSignal({ projectId: 'p3', signalKey: 'links', hash, payload: { ok: true }, ttlSec: 3600 }, db);
    const row = await readSignal({ projectId: 'p3', signalKey: 'links', hash }, db);
    assert.ok(row && row.hit === true);
    assert.deepStrictEqual(row.payload, { ok: true });
  });

  console.log(`\nSignal-cache smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
