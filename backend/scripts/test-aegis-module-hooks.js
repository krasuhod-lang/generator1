'use strict';
const assert = require('assert');

function freshLoad(envOverrides) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/aegis/')) delete require.cache[k];
  }
  if (envOverrides) Object.assign(process.env, envOverrides);
  return {
    hooks:     require('../src/services/aegis/moduleHooks'),
    telemetry: require('../src/services/aegis/telemetry'),
    flags:     require('../src/services/aegis/featureFlags'),
  };
}

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}

(async () => {
  console.log('\n=== aegis/moduleHooks ===');

  await test('observeStage returns null when AEGIS_ENABLED=false', () => {
    const { hooks } = freshLoad({ AEGIS_ENABLED: 'false' });
    assert.strictEqual(hooks.observeStage({ module: 'X', stage: 'Y' }), null);
  });

  await test('emits counter + latency when enabled', () => {
    const { hooks, telemetry } = freshLoad({ AEGIS_ENABLED: 'true' });
    hooks.observeStage({ module: 'parser', stage: 'extract_hidden_layers', outcome: 'ok', durationMs: 120 });
    hooks.observeStage({ module: 'parser', stage: 'extract_hidden_layers', outcome: 'warn', durationMs: 80, warnings: { empty: 1 } });
    const snap = telemetry.snapshot();
    const ok = Object.keys(snap.counters).find((k) =>
      k.includes('aegis_module_stages_total') && k.includes('module="parser"') && k.includes('outcome="ok"'));
    const warn = Object.keys(snap.counters).find((k) =>
      k.includes('aegis_module_stages_total') && k.includes('outcome="warn"'));
    assert.ok(ok); assert.ok(warn);
    assert.strictEqual(snap.counters[ok], 1);
    const lat = Object.keys(snap.histograms).find((k) =>
      k.includes('aegis_module_stage_latency_ms') && k.includes('stage="extract_hidden_layers"'));
    assert.ok(lat); assert.strictEqual(snap.histograms[lat].count, 2);
    const warns = Object.keys(snap.counters).find((k) =>
      k.includes('aegis_module_warnings_total') && k.includes('kind="empty"'));
    assert.ok(warns);
  });

  await test('wrapStage measures success and propagates result', async () => {
    const { hooks, telemetry } = freshLoad({ AEGIS_ENABLED: 'true' });
    const r = await hooks.wrapStage({ module: 'metaTags', stage: 'gen' }, async () => 42);
    assert.strictEqual(r, 42);
    const snap = telemetry.snapshot();
    assert.ok(Object.keys(snap.counters).some((k) =>
      k.includes('aegis_module_stages_total') && k.includes('module="metaTags"')));
  });

  await test('wrapStage rethrows and records outcome=error', async () => {
    const { hooks, telemetry } = freshLoad({ AEGIS_ENABLED: 'true' });
    let thrown = false;
    try { await hooks.wrapStage({ module: 'X', stage: 'Y' }, async () => { throw new Error('boom'); }); }
    catch (e) { thrown = true; assert.strictEqual(e.message, 'boom'); }
    assert.ok(thrown);
    const snap = telemetry.snapshot();
    assert.ok(Object.keys(snap.counters).some((k) => k.includes('outcome="error"')));
  });

  await test('moduleHooks flag is exposed and enabled by default', () => {
    const { flags } = freshLoad({ AEGIS_ENABLED: 'true' });
    const f = flags.getAegisFlags();
    assert.ok(f.moduleHooks);
    assert.strictEqual(f.moduleHooks.enabled, true);
    assert.strictEqual(f.moduleHooks.qualityGate, false);
  });

  await test('truncates oversized module/stage strings', () => {
    const { hooks, telemetry } = freshLoad({ AEGIS_ENABLED: 'true' });
    hooks.observeStage({ module: 'a'.repeat(100), stage: 'b'.repeat(100) });
    const snap = telemetry.snapshot();
    const k = Object.keys(snap.counters).find((s) => s.includes('aegis_module_stages_total'));
    assert.ok(k);
    assert.ok(k.includes('a'.repeat(40)));
    assert.ok(!k.includes('a'.repeat(41)));
  });

  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
