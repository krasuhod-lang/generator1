'use strict';

const assert = require('assert');
const {
  calcCost,
  calculateCostBreakdown,
  splitDeepSeekInput,
  getDeepSeekPricingMode,
  normalizeDeepSeekModel,
} = require('../src/services/metrics/priceCalculator');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function closeTo(actual, expected, epsilon = 1e-12) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) <= epsilon, `expected ${expected}, got ${actual}`);
}

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = String(value);
  }
  try { return fn(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

check('DeepSeek V4 Flash off-peak cache hit + output', () => {
  const r = calculateCostBreakdown('deepseek-v4-flash', 1_000_000, 1_000_000, { cacheHitTokens: 1_000_000, cacheMissTokens: 0, pricingMode: 'off_peak' });
  assert.strictEqual(r.modelTier, 'deepseek-v4-flash');
  assert.strictEqual(r.pricingMode, 'off_peak');
  assert.strictEqual(r.cacheHitTokens, 1_000_000);
  assert.strictEqual(r.cacheMissTokens, 0);
  closeTo(r.inputCostUsd, 0.007);
  closeTo(r.outputCostUsd, 0.66);
  closeTo(r.totalUsd, 0.667);
});

check('DeepSeek V4 Flash peak cache hit + output', () => {
  const r = calculateCostBreakdown('deepseek-v4-flash', 1_000_000, 1_000_000, { cacheHitTokens: 1_000_000, pricingMode: 'peak' });
  closeTo(r.inputCostUsd, 0.014);
  closeTo(r.outputCostUsd, 1.32);
  closeTo(r.totalUsd, 1.334);
});

check('DeepSeek V4 Flash off-peak cache miss + output', () => {
  const r = calculateCostBreakdown('deepseek-v4-flash', 1_000_000, 1_000_000, { cacheHitTokens: 0, cacheMissTokens: 1_000_000, pricingMode: 'off_peak' });
  closeTo(r.inputCostUsd, 0.22);
  closeTo(r.outputCostUsd, 0.66);
  closeTo(r.totalUsd, 0.88);
});

check('DeepSeek V4 Pro off-peak and peak tiers', () => {
  const offPeak = calculateCostBreakdown('deepseek-v4-pro', 1_000_000, 1_000_000, { cacheMissTokens: 1_000_000, pricingMode: 'off_peak' });
  const peak = calculateCostBreakdown('deepseek-v4-pro', 1_000_000, 1_000_000, { cacheHitTokens: 1_000_000, pricingMode: 'peak' });
  closeTo(offPeak.totalUsd, 2.64);
  closeTo(peak.inputCostUsd, 0.044);
  closeTo(peak.outputCostUsd, 3.96);
  closeTo(peak.totalUsd, 4.004);
});

check('DeepSeek partial cache split never discounts the miss portion', () => {
  const split = splitDeepSeekInput(1_000_000, { cacheHitTokens: 250_000, cacheMissTokens: 750_000 });
  assert.deepStrictEqual(split, { cacheHitTokens: 250_000, cacheMissTokens: 750_000 });
  const r = calculateCostBreakdown('deepseek-v4-flash', 1_000_000, 0, { ...split, pricingMode: 'off_peak' });
  closeTo(r.inputCostUsd, 0.16675);
  closeTo(r.totalUsd, 0.16675);
});

check('DeepSeek omitted residual split is charged as cache miss', () => {
  assert.deepStrictEqual(splitDeepSeekInput(1_000_000, { cacheHitTokens: 250_000 }), { cacheHitTokens: 250_000, cacheMissTokens: 750_000 });
});

check('Backward-compatible calcCost boolean cacheHit remains valid', () => {
  withEnv({ DEEPSEEK_PRICING_MODE: 'off_peak' }, () => {
    closeTo(calcCost('deepseek-v4-flash', 1_000_000, 1_000_000, true), 0.667);
    closeTo(calcCost('deepseek-v4-flash', 1_000_000, 1_000_000, false), 0.88);
  });
});

check('Gemini short context includes cached input and thoughts as output', () => {
  const r = calculateCostBreakdown('gemini', 100_000, 10_000, { cachedTokens: 50_000, thoughtsTokens: 2_000 });
  closeTo(r.inputCostUsd, 0.125);
  closeTo(r.outputCostUsd, 0.144);
  closeTo(r.totalUsd, 0.269);
});

check('Gemini long context selects the long-context tier', () => {
  const r = calculateCostBreakdown('gemini', 300_000, 20_000, { cachedTokens: 100_000, thoughtsTokens: 5_000 });
  assert.strictEqual(r.modelTier, 'gemini-long-context');
  closeTo(r.inputCostUsd, 0.9);
  closeTo(r.outputCostUsd, 0.45);
  closeTo(r.totalUsd, 1.35);
});

check('Grok default input/output rates remain deterministic', () => {
  const r = calculateCostBreakdown('grok', 1_000_000, 1_000_000);
  closeTo(r.inputCostUsd, 2);
  closeTo(r.outputCostUsd, 6);
  closeTo(r.totalUsd, 8);
});

check('DeepSeek peak schedule uses UTC boundaries', () => {
  withEnv({ DEEPSEEK_PRICING_MODE: 'auto' }, () => {
    assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T00:59:59Z')), 'off_peak');
    assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T01:00:00Z')), 'peak');
    assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T03:59:59Z')), 'peak');
    assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T04:00:00Z')), 'off_peak');
    assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T06:00:00Z')), 'peak');
    assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T10:00:00Z')), 'off_peak');
  });
});

check('DEEPSEEK_PRICING_MODE overrides auto for deterministic operations', () => {
  withEnv({ DEEPSEEK_PRICING_MODE: 'off_peak' }, () => assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T02:00:00Z')), 'off_peak'));
  withEnv({ DEEPSEEK_PRICING_MODE: 'peak' }, () => assert.strictEqual(getDeepSeekPricingMode(new Date('2026-08-21T12:00:00Z')), 'peak'));
});

check('DeepSeek model aliases resolve to the correct pricing tier', () => {
  assert.strictEqual(normalizeDeepSeekModel('deepseek-v4-flash'), 'deepseek_v4_flash');
  assert.strictEqual(normalizeDeepSeekModel('deepseek-reasoner'), 'deepseek_v4_pro');
  withEnv({ DEEPSEEK_MODEL: 'deepseek-v4-flash' }, () => assert.strictEqual(normalizeDeepSeekModel('deepseek'), 'deepseek_v4_flash'));
});

console.log(`\nAll LLM pricing accuracy tests passed (${passed} checks).`);
process.exitCode = 0;
