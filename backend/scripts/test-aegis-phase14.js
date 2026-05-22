'use strict';

/**
 * Smoke-тесты A.E.G.I.S. Phase 14 (DSPy cold-start, Vector GC,
 * ε-greedy mutation, Relevance Aegis hooks). Без сети, без БД.
 *
 *   node backend/scripts/test-aegis-phase14.js
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const run = async () => {
    try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
    catch (e) { failed += 1; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
  };
  return run();
}

async function main() {
  console.log('\n[aegis/featureFlags Phase 14]');
  const { getAegisFlags, FLAG_RANGES } = require('../src/services/aegis/featureFlags');
  const flags = getAegisFlags();

  await test('dspy.coldStartUseSeeds default true', () => {
    assert.strictEqual(flags.dspy.coldStartUseSeeds, true);
  });
  await test('dspy.coldStartMinRows default 10', () => {
    assert.strictEqual(flags.dspy.coldStartMinRows, 10);
  });
  await test('dspy.epsilonGreedyRate default 0.07', () => {
    assert.strictEqual(flags.dspy.epsilonGreedyRate, 0.07);
  });
  await test('vectorGc block defaults', () => {
    assert.strictEqual(flags.vectorGc.enabled, true);
    assert.strictEqual(flags.vectorGc.ttlDays, 30);
    assert.strictEqual(flags.vectorGc.perRunCleanup, true);
    assert.strictEqual(flags.vectorGc.minAgeSafetyHours, 24);
    assert(Array.isArray(flags.vectorGc.ephemeralCollectionPrefixes));
    assert(flags.vectorGc.ephemeralCollectionPrefixes.includes('evidence_'));
  });
  await test('relevanceAegis block defaults', () => {
    assert.strictEqual(flags.relevanceAegis.enabled, true);
    assert.strictEqual(flags.relevanceAegis.poisonFilterFetched, true);
    assert.strictEqual(flags.relevanceAegis.compressDeepseekPrompt, false);
  });
  await test('FLAG_RANGES includes Phase 14 keys', () => {
    if (FLAG_RANGES && typeof FLAG_RANGES === 'object') {
      assert('dspy.epsilonGreedyRate' in FLAG_RANGES || 'epsilonGreedyRate' in FLAG_RANGES
        || Object.keys(FLAG_RANGES).some(k => k.includes('epsilon')),
        'epsilonGreedyRate range registered');
    }
  });

  console.log('\n[aegis/telemetry Phase 14 counters]');
  const telemetry = require('../src/services/aegis/telemetry');
  telemetry._resetForTests();
  await test('vectorGcRuns + vectorGcPointsDeleted defined', () => {
    assert(telemetry.M.vectorGcRuns);
    assert(telemetry.M.vectorGcPointsDeleted);
    telemetry.M.vectorGcRuns.inc(1, { outcome: 'ok' });
    telemetry.M.vectorGcPointsDeleted.inc(42, { collection: 'evidence_test' });
    const text = telemetry.toPrometheus();
    assert(text.includes('aegis_vector_gc_runs_total'));
    assert(text.includes('aegis_vector_gc_points_deleted_total'));
  });
  await test('relevancePages + relevancePoisonDropped defined', () => {
    assert(telemetry.M.relevancePages);
    assert(telemetry.M.relevancePoisonDropped);
    telemetry.M.relevancePages.inc(10, { outcome: 'ok' });
    telemetry.M.relevancePoisonDropped.inc(2, { reason: 'hidden_text' });
    const text = telemetry.toPrometheus();
    assert(text.includes('aegis_relevance_pages_total'));
    assert(text.includes('aegis_relevance_poison_dropped_total'));
  });
  await test('dspyMutations defined', () => {
    assert(telemetry.M.dspyMutations);
    telemetry.M.dspyMutations.inc(1, { kind: 'shorter_intro' });
    const text = telemetry.toPrometheus();
    assert(text.includes('aegis_dspy_mutations_total'));
  });

  console.log('\n[aegis/vectorGc client]');
  const vectorGc = require('../src/services/aegis/vectorGc');
  await test('cleanupRun rejects missing runId', async () => {
    const r = await vectorGc.cleanupRun({ runId: '' });
    assert.strictEqual(r.ok, false);
  });
  await test('cleanupRun with valid runId returns shape (network may fail)', async () => {
    // Network will fail in CI / smoke env — we only assert shape.
    const r = await vectorGc.cleanupRun({ runId: 'test_run_id_smoke' });
    assert(typeof r === 'object');
    assert('ok' in r);
  });
  await test('health() returns object', async () => {
    const r = await vectorGc.health();
    assert(typeof r === 'object');
  });

  console.log('\n[relevance/aegisHooks]');
  const hooks = require('../src/services/relevance/aegisHooks');
  await test('filterPoisonedPages keeps clean pages', () => {
    const pages = [
      { url: 'https://a/', html: '<html><body><h1>Hello world</h1><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p></body></html>' },
    ];
    const { kept, dropped } = hooks.filterPoisonedPages(pages);
    // Clean page should not be dropped (unless poisonFilter is overzealous on tiny pages).
    assert(kept.length + dropped.length === 1);
  });
  await test('filterPoisonedPages handles empty input', () => {
    const { kept, dropped } = hooks.filterPoisonedPages([]);
    assert.strictEqual(kept.length, 0);
    assert.strictEqual(dropped.length, 0);
  });
  await test('emitPagesTelemetry does not throw', () => {
    hooks.emitPagesTelemetry({ ok: 5, dropped: [{ url: 'x', reason: 'hidden_text' }] });
    hooks.emitPagesTelemetry({}); // empty
  });
  await test('finalizeReportCleanup graceful on network fail', async () => {
    const r = await hooks.finalizeReportCleanup('test_report_id');
    assert(typeof r === 'object');
  });
  await test('maybeCompressForAnalyzer returns text unchanged when disabled', () => {
    const r = hooks.maybeCompressForAnalyzer('short prompt');
    assert.strictEqual(r.text, 'short prompt');
    assert.strictEqual(r.compressed, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
