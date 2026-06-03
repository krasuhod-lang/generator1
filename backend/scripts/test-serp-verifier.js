'use strict';

/**
 * Smoke-тест верификации каннибализации по топ-выдаче Google
 * (backend/src/services/projects/serpVerifier.js) и порционной обработки
 * больших данных (backend/src/services/projects/batchAnalyzer.js).
 * Детерминированный, без сети/LLM (SERP и map/reduce инъектируются).
 *
 * Запуск: node backend/scripts/test-serp-verifier.js
 */

const assert = require('assert');
const {
  verifyCannibalization, _rankedSerp, _sameUrl, _buildVerdict, _cacheClear,
} = require('../src/services/projects/serpVerifier');
const {
  chunkArray, estimateWorkload, shouldBatch, buildChunks, runMapReduce, _mapLimited,
} = require('../src/services/projects/batchAnalyzer');
const { getProjectsConfig } = require('../src/services/projects/config');

let passed = 0;
let failed = 0;
function test(name, fn) {
  Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log(`  \u2713 ${name}`); })
    .catch((err) => { failed += 1; console.error(`  \u2717 ${name}\n    ${err.message}`); });
}

// ── URL matching ──────────────────────────────────────────────────────
test('_sameUrl: host/path normalization (www, trailing slash, scheme)', () => {
  assert.ok(_sameUrl('https://site.ru/catalog/', 'http://www.site.ru/catalog'));
  assert.ok(_sameUrl('site.ru/a/b', 'https://site.ru/a/b'));
  assert.ok(!_sameUrl('https://site.ru/a', 'https://site.ru/b'));
  assert.ok(!_sameUrl('https://site.ru/a', 'https://other.ru/a'));
});

test('_rankedSerp dedups by normalized url, keeps host-duplicates, assigns positions', () => {
  const ranked = _rankedSerp([
    { url: 'https://site.ru/a' },
    { url: 'https://www.site.ru/a/' }, // дубль /a → отбрасываем
    { url: 'https://site.ru/b' },      // вторая страница того же сайта — сохраняем
    { url: 'https://comp.ru/x' },
  ]);
  assert.strictEqual(ranked.length, 3);
  assert.strictEqual(ranked[0].position, 1);
  assert.strictEqual(ranked[1].path, '/b');
  assert.strictEqual(ranked[2].host, 'comp.ru');
});

// ── Verdict logic ─────────────────────────────────────────────────────
const cfg = getProjectsConfig().serpVerification;

test('_buildVerdict: merge_recommended when >=2 site pages in top and none in top-3', () => {
  const ranked = _rankedSerp([
    { url: 'https://comp.ru/x' },
    { url: 'https://comp2.ru/y' },
    { url: 'https://comp3.ru/z' },
    { url: 'https://site.ru/a' }, // pos 4
    { url: 'https://site.ru/b' }, // pos 5
  ]);
  const v = _buildVerdict({ query: 'купить котёл', pages: [{ page: 'https://site.ru/a' }, { page: 'https://site.ru/b' }] }, ranked, cfg);
  assert.strictEqual(v.verdict, 'merge_recommended');
  assert.strictEqual(v.site_pages_in_top_count, 2);
  assert.strictEqual(v.best_position, 4);
});

test('_buildVerdict: keep_separate when a clear leader is in top-3', () => {
  const ranked = _rankedSerp([
    { url: 'https://site.ru/a' }, // pos 1 — лидер
    { url: 'https://comp.ru/x' },
    { url: 'https://comp2.ru/y' },
    { url: 'https://site.ru/b' }, // pos 4
  ]);
  const v = _buildVerdict({ query: 'q', pages: [{ page: 'https://site.ru/a' }, { page: 'https://site.ru/b' }] }, ranked, cfg);
  assert.strictEqual(v.verdict, 'keep_separate');
});

test('_buildVerdict: keep_separate when <=1 site page in top', () => {
  const ranked = _rankedSerp([
    { url: 'https://comp.ru/x' },
    { url: 'https://site.ru/a' },
  ]);
  const v = _buildVerdict({ query: 'q', pages: [{ page: 'https://site.ru/a' }, { page: 'https://site.ru/b' }] }, ranked, cfg);
  assert.strictEqual(v.verdict, 'keep_separate');
  assert.strictEqual(v.site_pages_in_top_count, 1);
});

// ── verifyCannibalization (injected fetch) ────────────────────────────
test('verifyCannibalization: confirms merge via injected SERP', async () => {
  _cacheClear();
  const fetchSerp = async () => ([
    { url: 'https://comp.ru/x' }, { url: 'https://comp2.ru/y' }, { url: 'https://comp3.ru/z' },
    { url: 'https://site.ru/a' }, { url: 'https://site.ru/b' },
  ]);
  const res = await verifyCannibalization({
    candidates: [{ query: 'купить котёл', pages: [{ page: 'https://site.ru/a' }, { page: 'https://site.ru/b' }] }],
    fetchSerp,
  });
  assert.strictEqual(res.available, true);
  assert.strictEqual(res.items.length, 1);
  assert.strictEqual(res.items[0].verdict, 'merge_recommended');
});

test('verifyCannibalization: graceful inconclusive when fetch throws', async () => {
  _cacheClear();
  const fetchSerp = async () => { throw new Error('network down'); };
  const res = await verifyCannibalization({
    candidates: [{ query: 'q', pages: [{ page: 'https://site.ru/a' }] }],
    fetchSerp,
  });
  assert.strictEqual(res.items[0].verdict, 'inconclusive');
  assert.ok(res.warnings.length >= 1);
});

test('verifyCannibalization: respects maxCandidates cap', async () => {
  _cacheClear();
  let calls = 0;
  const fetchSerp = async () => { calls += 1; return [{ url: 'https://comp.ru/x' }]; };
  const many = Array.from({ length: cfg.maxCandidates + 5 }, (_, i) => ({ query: `q${i}`, pages: [{ page: 'https://site.ru/a' }] }));
  const res = await verifyCannibalization({ candidates: many, fetchSerp });
  assert.strictEqual(res.items.length, cfg.maxCandidates);
  assert.strictEqual(calls, cfg.maxCandidates);
});

test('verifyCannibalization: empty candidates → not available, no calls', async () => {
  _cacheClear();
  const res = await verifyCannibalization({ candidates: [] });
  assert.strictEqual(res.available, false);
  assert.strictEqual(res.items.length, 0);
});

// ── batchAnalyzer ─────────────────────────────────────────────────────
test('chunkArray splits evenly and keeps remainder', () => {
  assert.deepStrictEqual(chunkArray([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepStrictEqual(chunkArray([], 3), []);
});

test('estimateWorkload / shouldBatch threshold', () => {
  const bcfg = getProjectsConfig().batch;
  const small = estimateWorkload({ topQueries: new Array(10), queryPage: new Array(50) });
  const big = estimateWorkload({ topQueries: new Array(50), queryPage: new Array(1000) });
  assert.strictEqual(shouldBatch(small, bcfg), small > bcfg.workloadThreshold);
  assert.strictEqual(shouldBatch(big, bcfg), true);
  assert.strictEqual(shouldBatch(big, { enabled: false, workloadThreshold: 1 }), false);
});

test('buildChunks caps at maxChunks, never drops rows', () => {
  const bcfg = { chunkSize: 10, maxChunks: 3 };
  const queryPage = Array.from({ length: 100 }, (_, i) => ({ query: `q${i}`, page: `/p${i}` }));
  const chunks = buildChunks({ queryPage, topQueries: [] }, bcfg);
  assert.strictEqual(chunks.length, 3);
  const totalRows = chunks.reduce((s, c) => s + c.items.length, 0);
  assert.strictEqual(totalRows, 100); // ничего не потеряли
  assert.strictEqual(chunks[2].items.length, 80); // хвост схлопнут в последнюю
});

test('buildChunks prefers queryPage, falls back to topQueries', () => {
  const chunks = buildChunks({ queryPage: [], topQueries: [1, 2, 3] }, { chunkSize: 2, maxChunks: 10 });
  assert.strictEqual(chunks.length, 2);
});

test('_mapLimited keeps order and isolates failures', async () => {
  const res = await _mapLimited([1, 2, 3], 2, async (x) => {
    if (x === 2) throw new Error('boom');
    return x * 10;
  });
  assert.strictEqual(res[0].value, 10);
  assert.strictEqual(res[1].ok, false);
  assert.strictEqual(res[2].value, 30);
});

test('runMapReduce: map-reduce over chunks, skips failed chunk', async () => {
  const chunks = buildChunks({ queryPage: Array.from({ length: 6 }, (_, i) => ({ i })) }, { chunkSize: 2, maxChunks: 10 });
  const out = await runMapReduce({
    chunks,
    mapFn: async (c) => (c.index === 2 ? Promise.reject(new Error('x')) : `part${c.index}`),
    reduceFn: async (partials, meta) => ({ joined: partials.join('+'), meta }),
    concurrency: 2,
  });
  assert.strictEqual(out.result.joined, 'part1+part3');
  assert.strictEqual(out.stats.failed_count, 1);
  assert.ok(out.warnings.some((w) => w.includes('map_chunk_2_failed')));
});

test('runMapReduce: throws if all chunks fail', async () => {
  const chunks = buildChunks({ queryPage: [{ a: 1 }, { a: 2 }] }, { chunkSize: 1, maxChunks: 10 });
  await assert.rejects(runMapReduce({
    chunks,
    mapFn: async () => { throw new Error('all down'); },
    reduceFn: async () => 'never',
  }));
});

// ── Summary ───────────────────────────────────────────────────────────
setTimeout(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}, 200);
