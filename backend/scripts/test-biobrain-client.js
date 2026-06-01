'use strict';

/**
 * test-biobrain-client.js — детерминированные смоук-тесты для
 * aegis/biobrainClient.js, aegis/biobrainScheduler.js и telemetry-хелперов
 * Bio-Brain. Без сети и без БД: Python-сервис aegis_py недоступен, поэтому
 * клиент graceful-деградирует (ok:false), а планировщик корректно снимает
 * причину «почему прочерки».
 *
 * Запуск:  node backend/scripts/test-biobrain-client.js
 */

const assert = require('assert');
const path   = require('path');

const SVC = (m) => require(path.join(__dirname, '..', 'src', 'services', 'aegis', m));

const biobrain  = SVC('biobrainClient');
const scheduler = SVC('biobrainScheduler');
const telemetry = SVC('telemetry');

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try { fn(); _pass += 1; console.log(`  ✓ ${name}`); }
  catch (e) { console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`); }
}

check('biobrainClient exports predict/feedback/advice/status', () => {
  for (const fn of ['predict', 'feedback', 'advice', 'status']) {
    assert.strictEqual(typeof biobrain[fn], 'function', `missing ${fn}`);
  }
});

check('telemetry.recordBiobrainPrediction counts fast_reject', () => {
  telemetry._resetForTests();
  telemetry.recordBiobrainPrediction({ gate: 'fast_reject' });
  telemetry.recordBiobrainPrediction({ gate: 'pass' });
  const snap = telemetry.snapshot();
  const fr = Object.entries(snap.counters)
    .find(([k]) => k.startsWith('aegis_biobrain_fast_reject_total'));
  assert.ok(fr, 'fast_reject counter missing');
  assert.strictEqual(fr[1], 1);
});

check('telemetry.recordBiobrainState sets gauges + evolve delta', () => {
  telemetry._resetForTests();
  telemetry.recordBiobrainState({ generation: 5, mean_fitness: 0.9, buffer_size: 40, evolve_count: 3 });
  telemetry.recordBiobrainState({ generation: 6, mean_fitness: 0.95, buffer_size: 42, evolve_count: 5 });
  const snap = telemetry.snapshot();
  assert.strictEqual(snap.gauges.aegis_biobrain_generation, 6);
  assert.strictEqual(snap.gauges.aegis_biobrain_buffer_size, 42);
  const ev = Object.entries(snap.counters)
    .find(([k]) => k.startsWith('aegis_biobrain_evolve_total'));
  assert.ok(ev, 'evolve counter missing');
  assert.strictEqual(ev[1], 2, 'should count only delta 5-3=2');
});

check('telemetry.recordBiobrainState tolerates junk input', () => {
  telemetry._resetForTests();
  assert.doesNotThrow(() => telemetry.recordBiobrainState(null));
  assert.doesNotThrow(() => telemetry.recordBiobrainState({ generation: 'x' }));
});

// ── Async: клиент и планировщик при недоступном py ───────────────────
const tAsync = (async () => {
  const s = await biobrain.status();
  check('biobrain.status() returns ok:false without throwing', () => {
    assert.ok(s && typeof s === 'object');
    assert.strictEqual(s.ok, false);
  });

  const p = await biobrain.predict({ text: 'demo', signals: { readability: 70 } });
  check('biobrain.predict() returns ok:false without throwing', () => {
    assert.ok(p && typeof p === 'object');
    assert.strictEqual(p.ok, false);
  });

  const a = await biobrain.advice({ text: 'demo' });
  check('biobrain.advice() returns ok:false without throwing', () => {
    assert.ok(a && typeof a === 'object');
    assert.strictEqual(a.ok, false);
  });

  const f = await biobrain.feedback({
    features: [0.1, 0.2, 0.3, 0.4, 0.5, 0.2, 0.1, 1.0],
    predicted: 0.5,
    real_spq_overall: 82,
    real_eeat: 75,
  });
  check('biobrain.feedback() returns ok:false without throwing', () => {
    assert.ok(f && typeof f === 'object');
    assert.strictEqual(f.ok, false);
  });

  await scheduler.tick();
  const tel = scheduler.getBiobrainSchedulerTelemetry();
  check('scheduler.tick() populates telemetry reason', () => {
    assert.ok(tel && typeof tel === 'object');
    assert.strictEqual(tel.available, false);
    assert.ok(tel.reason, 'reason should be set (network/disabled)');
    assert.ok(tel.last_check_at, 'last_check_at should be set');
  });
})();

tAsync.then(() => {
  console.log('\n' + '─'.repeat(60));
  if (_pass === _cases) {
    console.log(`✅ All ${_cases} biobrain-client tests passed`);
    process.exit(0);
  } else {
    console.log(`❌ ${_cases - _pass}/${_cases} biobrain-client tests failed`);
    process.exit(1);
  }
});
