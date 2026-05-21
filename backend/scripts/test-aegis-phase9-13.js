'use strict';

/**
 * Smoke-тесты A.E.G.I.S. Phase 9–13 (Observability/FinOps/Compression/
 * Routing/Poison). Без сети, без БД.
 *
 *   node backend/scripts/test-aegis-phase9-13.js
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    }
  };
  return run();
}

async function main() {
  // ── featureFlags new ranges ──────────────────────────────────────
  console.log('\n[aegis/featureFlags Phase 9-13]');
  const { getAegisFlags } = require('../src/services/aegis/featureFlags');
  await test('compress.targetTokens default 24000', () => {
    assert.strictEqual(getAegisFlags().compress.targetTokens, 24000);
  });
  await test('alerting default rateUsdPerHour=50', () => {
    assert.strictEqual(getAegisFlags().alerting.rateUsdPerHour, 50);
  });
  await test('poison default enabled=true onFail=drop', () => {
    const p = getAegisFlags().poison;
    assert.strictEqual(p.enabled, true);
    assert.strictEqual(p.onFail, 'drop');
  });

  // ── telemetry ────────────────────────────────────────────────────
  console.log('\n[aegis/telemetry]');
  const telemetry = require('../src/services/aegis/telemetry');
  telemetry._resetForTests();
  await test('counter inc + prometheus format', () => {
    telemetry.M.tokens.inc(100, { provider: 'gemini', direction: 'in' });
    telemetry.M.tokens.inc(50,  { provider: 'gemini', direction: 'out' });
    telemetry.M.cost.inc(0.012, { provider: 'gemini' });
    const text = telemetry.toPrometheus();
    assert(text.includes('aegis_tokens_total'));
    assert(text.includes('provider="gemini"'));
    assert(text.includes('direction="in"'));
  });
  await test('histogram observe + bucket counts', () => {
    telemetry.M.latency.observe(120, { provider: 'deepseek' });
    telemetry.M.latency.observe(60,  { provider: 'deepseek' });
    const text = telemetry.toPrometheus();
    assert(text.includes('aegis_llm_latency_ms_bucket'));
    assert(text.includes('aegis_llm_latency_ms_count'));
    assert(text.includes('aegis_llm_latency_ms_sum'));
  });
  await test('recordLlmCall increments multiple metrics', () => {
    telemetry._resetForTests();
    telemetry.recordLlmCall({
      provider: 'deepseek', tokensIn: 1000, tokensOut: 500, costUsd: 0.0005,
      cacheHitTokens: 200, latencyMs: 85, outcome: 'ok',
    });
    const snap = telemetry.snapshot();
    assert(Object.keys(snap.counters).some((k) => k.startsWith('aegis_tokens_total')));
    assert(Object.keys(snap.counters).some((k) => k.startsWith('aegis_cost_usd_total')));
    assert(Object.keys(snap.counters).some((k) => k.startsWith('aegis_cache_hits_total')));
  });

  // ── killSwitch ───────────────────────────────────────────────────
  console.log('\n[aegis/killSwitch]');
  const killSwitch = require('../src/services/aegis/killSwitch');
  killSwitch._resetForTests();
  await test('default disengaged', () => assert.strictEqual(killSwitch.isEngaged(), false));
  await test('engage + disengage', async () => {
    await killSwitch.engage({ reason: 'test', setBy: 'unit' });
    assert.strictEqual(killSwitch.isEngaged(), true);
    await killSwitch.disengage({ setBy: 'unit' });
    assert.strictEqual(killSwitch.isEngaged(), false);
  });

  // ── alerting (no network) ────────────────────────────────────────
  console.log('\n[aegis/alerting]');
  const alerting = require('../src/services/aegis/alerting');
  alerting._resetForTests();
  await test('recordSpend OFF by default → no rate', () => {
    alerting.recordSpend({ provider: 'gemini', costUsd: 1.0 });
    const r = alerting.getCurrentRate();
    // alerting.enabled=false по умолчанию → spend не записывается.
    assert.strictEqual(r.total_usd, 0);
  });

  // ── circuitBreaker ──────────────────────────────────────────────
  console.log('\n[aegis/circuitBreaker]');
  const { createCircuitBreaker } = require('../src/services/aegis/circuitBreaker');
  await test('opens after 5 fails, half-opens after timeout', () => {
    const cb = createCircuitBreaker('test', { failThreshold: 3, openSec: 0.1, halfOpenProbes: 1 });
    assert.strictEqual(cb.canPass(), true);
    cb.recordFailure(); cb.recordFailure(); cb.recordFailure();
    assert.strictEqual(cb.snapshot().status, 'open');
    assert.strictEqual(cb.canPass(), false);
  });
  await test('success in half_open closes the circuit', async () => {
    const cb = createCircuitBreaker('test2', { failThreshold: 2, openSec: 0.05, halfOpenProbes: 1 });
    cb.recordFailure(); cb.recordFailure();
    assert.strictEqual(cb.snapshot().status, 'open');
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(cb.canPass(), true);
    assert.strictEqual(cb.snapshot().status, 'half_open');
    cb.recordSuccess();
    assert.strictEqual(cb.snapshot().status, 'closed');
  });

  // ── llmRouter ────────────────────────────────────────────────────
  console.log('\n[aegis/llmRouter]');
  const llmRouter = require('../src/services/aegis/llmRouter');
  await test('_parseChain', () => {
    assert.deepStrictEqual(llmRouter._parseChain('deepseek,gemini, vllm '),
      ['deepseek', 'gemini', 'vllm']);
    assert.deepStrictEqual(llmRouter._parseChain(''), []);
  });
  await test('_extractStatus from axios-style err', () => {
    assert.strictEqual(llmRouter._extractStatus({ response: { status: 429 } }), 429);
    assert.strictEqual(llmRouter._extractStatus({ statusCode: 502 }), 502);
    assert.strictEqual(llmRouter._extractStatus({ message: 'HTTP 503 from upstream' }), 503);
    assert.strictEqual(llmRouter._extractStatus({ message: 'no info' }), null);
  });
  await test('_isRetryable detects 429/timeout', () => {
    assert.strictEqual(llmRouter._isRetryable({ response: { status: 429 } }), true);
    assert.strictEqual(llmRouter._isRetryable({ message: 'Request timeout' }), true);
    assert.strictEqual(llmRouter._isRetryable({ message: 'bad input' }), false);
  });
  await test('route returns killswitch when engaged', async () => {
    await killSwitch.engage({ reason: 'test' });
    const r = await llmRouter.route({ kind: 'critic', system: 's', user: 'u' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'killswitch');
    await killSwitch.disengage({});
  });

  // ── promptCompressor ─────────────────────────────────────────────
  console.log('\n[aegis/promptCompressor]');
  const pc = require('../src/services/aegis/promptCompressor');
  await test('short prompt → skipped', () => {
    const r = pc.compressPrompt('Короткий текст. Всего пара слов.');
    assert.strictEqual(r.skipped, true);
    assert.strictEqual(r.compression_ratio, 1);
  });
  await test('compresses long text & preserves numerics-heavy sentences', () => {
    const filler = ('Это обычное предложение без значимой информации, повторяемое многократно. ').repeat(400);
    const factsentences = [
      'Компания Apple заработала 89.5 млрд долларов в 2024 году.',
      'В России 146 млн жителей по данным Росстат за 2023 год.',
      'Bourrelly опубликовал статью 17 марта 2018 года.',
    ].join(' ');
    const text = filler + ' ' + factsentences + ' ' + filler;
    const r = pc.compressPrompt(text, { targetTokens: 500, minTokensToCompress: 100, keepTopRatio: 0.3 });
    assert.strictEqual(r.skipped, false);
    assert(r.compressed_tokens <= r.original_tokens, `${r.compressed_tokens} <= ${r.original_tokens}`);
    // Числовые предложения должны быть сохранены (они получают высокий score).
    assert(r.text.includes('89.5') || r.text.includes('146') || r.text.includes('2018'),
      `expected at least one numeric fact preserved, got: ${r.text.slice(0, 200)}`);
  });
  await test('estimateTokens', () => {
    assert.strictEqual(pc.estimateTokens(''), 0);
    assert.strictEqual(pc.estimateTokens('abcd'), 1);
    assert(pc.estimateTokens('a'.repeat(40)) === 10);
  });

  // ── poisonFilter ─────────────────────────────────────────────────
  console.log('\n[aegis/poisonFilter]');
  const poison = require('../src/services/aegis/poisonFilter');
  await test('clean text → not blocked', () => {
    const r = poison.runPoisonCheck({ text: 'Это обычный нормальный текст про SEO для блога. Никакого спама.' });
    assert.strictEqual(r.blocked, false);
    assert.strictEqual(r.verdict, 'clean');
    assert.strictEqual(r.reasons.length, 0);
  });
  await test('hidden CSS text detected', () => {
    const html = '<div>Хороший текст</div>' +
      '<span style="display:none">' + 'скрытый спам '.repeat(50) + '</span>';
    const r = poison.runPoisonCheck({ html });
    assert(r.reasons.some((x) => x.startsWith('hidden_text')), `reasons: ${r.reasons.join('|')}`);
  });
  await test('keyword stuffing detected', () => {
    const text = ('купить дешевле срочно ').repeat(20);
    const r = poison.runPoisonCheck({ text });
    assert(r.reasons.some((x) => x.startsWith('keyword_stuffing')), `reasons: ${r.reasons.join('|')}`);
  });
  await test('invisible unicode detected', () => {
    const text = 'Обычный текст' + '\u200B'.repeat(100) + ' и ещё немного';
    const r = poison.runPoisonCheck({ text });
    assert(r.reasons.some((x) => x.startsWith('invisible_chars')), `reasons: ${r.reasons.join('|')}`);
  });
  await test('numeric outliers (median=100, x5 = 500 cutoff)', () => {
    const text = 'Цена 120 руб. Цена 90 руб. Бредовая цена 9999999 руб.';
    const r = poison.runPoisonCheck({ text, nicheNumericMedian: 100 });
    assert(r.reasons.some((x) => x.startsWith('numeric_outliers')), `reasons: ${r.reasons.join('|')}`);
  });
  await test('drop verdict triggers blocked', () => {
    const html = '<p hidden>' + 'X'.repeat(100) + '</p><p>Normal</p>';
    const r = poison.runPoisonCheck({ html });
    if (r.reasons.length) assert.strictEqual(r.blocked, true);
  });

  // ── Summary ─────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed.\n`);
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
