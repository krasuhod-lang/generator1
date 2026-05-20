'use strict';

/**
 * test-advanced-math.js — smoke-тест для backend/src/services/forecaster/advancedMath.js.
 *
 * Запуск:  node backend/scripts/test-advanced-math.js
 * Цель: убедиться, что нелинейная математика прогнозатора возвращает
 *   физически осмысленные значения на корнер-кейсах (монотонность,
 *   границы, реакция на параметры). Никаких внешних сетевых вызовов.
 */

const assert = require('assert');
const {
  logisticPosition, calibrateLogistic,
  momentumRampUp, calibrateMomentumLambda,
  logReturns, logReturnsUnitsFor,
  calibratePowerLawCtr, ctrAtPosition,
  lognormalCompose,
  recoveryPotential,
  _bootstrapCtrParams,
  _normCdf,
} = require('../src/services/forecaster/advancedMath');

let passed = 0, failed = 0;
function it(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed += 1; }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed += 1; }
}
function group(name, fn) { console.log(`\n— ${name} —`); fn(); }

group('logisticPosition', () => {
  it('t=0 → текущая позиция (с округлением)', () => {
    const p = logisticPosition({ posNow: 25, posFloor: 3, t: 0, k: 0.35, t0: 6 });
    // при t=0: pos = 3 + 22/(1 + e^(0.35·-6)) = 3 + 22/(1+e^-2.1) ≈ 3+22/1.122 ≈ 22.6
    assert.ok(Math.abs(p - 22.6) < 0.3, `expected ~22.6, got ${p}`);
  });
  it('t→∞ стремится к posFloor', () => {
    const p = logisticPosition({ posNow: 50, posFloor: 5, t: 30, k: 0.5, t0: 6 });
    assert.ok(p < 6, `expected <6 near floor, got ${p}`);
  });
  it('монотонное убывание по t', () => {
    const a = logisticPosition({ posNow: 30, posFloor: 3, t: 2 });
    const b = logisticPosition({ posNow: 30, posFloor: 3, t: 6 });
    const c = logisticPosition({ posNow: 30, posFloor: 3, t: 12 });
    assert.ok(a >= b && b >= c, `not monotonic: ${a}, ${b}, ${c}`);
  });
  it('posNow ≤ posFloor → не «улучшаем»', () => {
    const p = logisticPosition({ posNow: 2, posFloor: 3, t: 12 });
    assert.strictEqual(p, 2);
  });
});

group('calibrateLogistic', () => {
  it('тяжёлая конкуренция + слабый effort → больший t0', () => {
    const a = calibrateLogistic({ competition: 0.9, effort: 0.1 });
    const b = calibrateLogistic({ competition: 0.1, effort: 0.9 });
    assert.ok(a.t0 > b.t0, `expected a.t0 > b.t0, got ${a.t0} vs ${b.t0}`);
    assert.ok(a.k  < b.k,  `expected a.k  < b.k,  got ${a.k}  vs ${b.k}`);
  });
});

group('momentumRampUp', () => {
  it('t=0 → 0', () => {
    assert.strictEqual(momentumRampUp({ upliftMax: 100, t: 0, lambda: 0.25 }), 0);
  });
  it('t→∞ → upliftMax', () => {
    const v = momentumRampUp({ upliftMax: 100, t: 30, lambda: 0.25 });
    assert.ok(v > 99.9, `expected ~100, got ${v}`);
  });
  it('монотонный рост', () => {
    const a = momentumRampUp({ upliftMax: 100, t: 2, lambda: 0.25 });
    const b = momentumRampUp({ upliftMax: 100, t: 6, lambda: 0.25 });
    assert.ok(b > a);
  });
});

group('logReturns', () => {
  it('units=0 → 0', () => {
    assert.strictEqual(logReturns({ units: 0 }), 0);
  });
  it('убывающая предельная отдача (per unit)', () => {
    const g10 = logReturns({ units: 10 });
    const g20 = logReturns({ units: 20 });
    const g30 = logReturns({ units: 30 });
    // прирост от 10→20 (10 units) > прирост от 20→30 (10 units) — diminishing
    assert.ok((g20 - g10) > (g30 - g20), `not diminishing: ${g10}, ${g20}, ${g30}`);
  });
  it('логарифмический рост, не степенной', () => {
    const g = logReturns({ units: 100, alpha: 1, scale: 10 });
    // 1 · ln(1 + 100/10) = ln(11) ≈ 2.398
    assert.ok(Math.abs(g - Math.log(11)) < 1e-9);
  });
  it('обратная функция возвращает кратное scale', () => {
    const u = logReturnsUnitsFor(Math.log(11), { alpha: 1, scale: 10 });
    assert.strictEqual(u, 100);
  });
});

group('calibratePowerLawCtr + ctrAtPosition', () => {
  it('калибровка по top-10 yandex — b в районе 1.0', () => {
    const fit = calibratePowerLawCtr({
      1: 0.281, 2: 0.157, 3: 0.109, 4: 0.080, 5: 0.061,
      6: 0.047, 7: 0.038, 8: 0.031, 9: 0.026, 10: 0.022,
    });
    assert.ok(fit.b > 0.8 && fit.b < 1.3, `expected b in [0.8,1.3], got ${fit.b}`);
    assert.ok(fit.r_squared > 0.95, `expected R²>0.95, got ${fit.r_squared}`);
  });
  it('CTR(1) > CTR(5) > CTR(10)', () => {
    const c1  = ctrAtPosition(1);
    const c5  = ctrAtPosition(5);
    const c10 = ctrAtPosition(10);
    assert.ok(c1 > c5 && c5 > c10);
  });
  it('дробная позиция работает', () => {
    const c47 = ctrAtPosition(4.7);
    const c4  = ctrAtPosition(4);
    const c5  = ctrAtPosition(5);
    assert.ok(c47 < c4 && c47 > c5, `expected between c4 and c5, got ${c47}`);
  });
});

group('lognormalCompose', () => {
  it('p50 ≈ exp(Σ log(factors))', () => {
    const r = lognormalCompose({ factors: [100, 0.1, 0.5], sigmaLog: 0.3 });
    // expected median = 100·0.1·0.5 = 5
    assert.ok(Math.abs(r.p50 - 5) < 0.1, `expected ~5, got ${r.p50}`);
  });
  it('p90 > p50 > p10', () => {
    const r = lognormalCompose({ factors: [1000, 0.05], sigmaLog: 0.3 });
    assert.ok(r.p90 > r.p50 && r.p50 > r.p10);
  });
  it('асимметричный CI (log-normal)', () => {
    const r = lognormalCompose({ factors: [100], sigmaLog: 0.3 });
    const upGap = r.p90 - r.p50;
    const dnGap = r.p50 - r.p10;
    assert.ok(upGap > dnGap, `expected upper gap > lower gap, got up=${upGap}, dn=${dnGap}`);
  });
  it('пустые factors → нули', () => {
    const r = lognormalCompose({ factors: [] });
    assert.strictEqual(r.p50, 0);
  });
});

group('recoveryPotential', () => {
  it('current ≥ baseline → нет gap', () => {
    const r = recoveryPotential({ baseline: 100, current: 120, effort: 0.5 });
    assert.strictEqual(r.gap, 0);
    assert.strictEqual(r.recovery, 0);
  });
  it('effort выше threshold → большая доля восстановления', () => {
    const lo = recoveryPotential({ baseline: 100, current: 20, effort: 0.1 });
    const hi = recoveryPotential({ baseline: 100, current: 20, effort: 0.8 });
    assert.ok(hi.recovery > lo.recovery);
    assert.ok(hi.recovery_fraction > 0.5);
    assert.ok(lo.recovery_fraction < 0.5);
  });
  it('gap=baseline−current корректен', () => {
    const r = recoveryPotential({ baseline: 100, current: 30, effort: 1.0 });
    assert.strictEqual(r.gap, 70);
  });
});

group('_normCdf sanity', () => {
  it('Φ(0) ≈ 0.5', () => { assert.ok(Math.abs(_normCdf(0) - 0.5) < 1e-6); });
  it('Φ(-1.96) ≈ 0.025', () => { assert.ok(Math.abs(_normCdf(-1.96) - 0.025) < 1e-3); });
  it('Φ(1.96) ≈ 0.975',  () => { assert.ok(Math.abs(_normCdf( 1.96) - 0.975) < 1e-3); });
});

group('_bootstrapCtrParams', () => {
  it('возвращает консистентные a,b', () => {
    const p = _bootstrapCtrParams();
    assert.ok(p.a > 0 && p.b > 0 && p.r_squared > 0.9);
  });
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
