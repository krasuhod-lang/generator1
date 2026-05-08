'use strict';

/**
 * test-priceCalculator.js — юнит-тесты для backend/src/services/metrics/priceCalculator.js.
 *
 * Покрывают «корректность учёта стоимости генерации» (Релиз 1, Block A ТЗ):
 *   • DeepSeek mixed-cache: cached × hit-rate + miss × miss-rate (новая формула).
 *   • DeepSeek legacy boolean cacheHit (BC).
 *   • Gemini long-tier выбирается по contextTokens, если он передан.
 *   • Gemini cached + thoughts корректно дисконтируются/добавляются.
 *   • Grok env-override и default.
 *   • DashScope: известная модель, неизвестная (default), env-override.
 *
 * Run:  node backend/scripts/test-priceCalculator.js
 */

const assert = require('assert');
const path   = require('path');

const {
  calcCost, PRICES, GEMINI_SHORT_CONTEXT_LIMIT, _resolveDashscopeRate,
} = require(path.join('..', 'src', 'services', 'metrics', 'priceCalculator'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// Допустимая числовая погрешность плавающей точки.
const EPS = 1e-12;
function near(a, b, eps = EPS) {
  return Math.abs(a - b) < eps;
}

// ─────────────────────────────────────────────────────────────────────
// DeepSeek
// ─────────────────────────────────────────────────────────────────────

test('deepseek: legacy cacheHit=false → cache_miss rate', () => {
  const cost = calcCost('deepseek', 1000, 500, false);
  const expected = 1000 * PRICES.deepseek.input_cache_miss
                 +  500 * PRICES.deepseek.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('deepseek: legacy cacheHit=true → cache_hit rate (всё-или-ничего)', () => {
  const cost = calcCost('deepseek', 1000, 500, true);
  const expected = 1000 * PRICES.deepseek.input_cache_hit
                 +  500 * PRICES.deepseek.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('deepseek: mixed cache via cachedTokens (4000 of 10000)', () => {
  const tIn = 10000, tOut = 2000, cached = 4000;
  const cost = calcCost('deepseek', tIn, tOut, { cachedTokens: cached });
  const expected = cached * PRICES.deepseek.input_cache_hit
                 + (tIn - cached) * PRICES.deepseek.input_cache_miss
                 + tOut  * PRICES.deepseek.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('deepseek: cachedTokens > tokensIn → clamp до tokensIn', () => {
  const tIn = 1000, tOut = 100;
  const cost = calcCost('deepseek', tIn, tOut, { cachedTokens: 99999 });
  const expected = tIn * PRICES.deepseek.input_cache_hit
                 + tOut * PRICES.deepseek.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('deepseek: cachedTokens=0 + cacheHit=true → fallback к legacy формуле', () => {
  const cost = calcCost('deepseek', 1000, 500, { cachedTokens: 0, cacheHit: true });
  const expected = 1000 * PRICES.deepseek.input_cache_hit
                 +  500 * PRICES.deepseek.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

// ─────────────────────────────────────────────────────────────────────
// Gemini
// ─────────────────────────────────────────────────────────────────────

test('gemini: short tier по умолчанию (tokensIn ≤ 200k)', () => {
  const cost = calcCost('gemini', 50000, 4000, {});
  const expected = 50000 * PRICES.gemini.input_short
                 +  4000 * PRICES.gemini.output_short;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('gemini: long tier через tokensIn > 200k (BC)', () => {
  const cost = calcCost('gemini', 250000, 4000, {});
  const expected = 250000 * PRICES.gemini.input_long
                 +   4000 * PRICES.gemini.output_long;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('gemini: long tier через contextTokens > 200k, даже если tokensIn мал', () => {
  // multi-turn кеш: реально подаётся всего 10k input, но контекст 250k.
  const cost = calcCost('gemini', 10000, 2000, { contextTokens: 250000 });
  const expected = 10000 * PRICES.gemini.input_long
                 +  2000 * PRICES.gemini.output_long;
  assert.ok(near(cost, expected),
    `long tier должен примениться по contextTokens, expected ${expected}, got ${cost}`);
});

test('gemini: cachedTokens дисконтируются (short tier)', () => {
  const tIn = 10000, tOut = 4000, cached = 6000;
  const cost = calcCost('gemini', tIn, tOut, { cachedTokens: cached });
  const expected = (tIn - cached) * PRICES.gemini.input_short
                 + cached * PRICES.gemini.cached_input_short
                 + tOut   * PRICES.gemini.output_short;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('gemini: thoughtsTokens добавляются как output (тариф long)', () => {
  const tIn = 250000, tOut = 4000, thoughts = 8000, cached = 100000;
  const cost = calcCost('gemini', tIn, tOut, {
    contextTokens: tIn, thoughtsTokens: thoughts, cachedTokens: cached,
  });
  const expected = (tIn - cached) * PRICES.gemini.input_long
                 + cached * PRICES.gemini.cached_input_long
                 + (tOut + thoughts) * PRICES.gemini.output_long;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('gemini: GEMINI_SHORT_CONTEXT_LIMIT === 200_000 (продуктовое требование)', () => {
  assert.strictEqual(GEMINI_SHORT_CONTEXT_LIMIT, 200_000);
});

// ─────────────────────────────────────────────────────────────────────
// Grok
// ─────────────────────────────────────────────────────────────────────

test('grok: дефолтные тарифы без env', () => {
  delete process.env.XAI_INPUT_PRICE_USD_PER_1M;
  delete process.env.XAI_OUTPUT_PRICE_USD_PER_1M;
  const cost = calcCost('grok', 1000, 500);
  const expected = 1000 * PRICES.grok.input + 500 * PRICES.grok.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('grok: env-override', () => {
  process.env.XAI_INPUT_PRICE_USD_PER_1M  = '5';
  process.env.XAI_OUTPUT_PRICE_USD_PER_1M = '10';
  const cost = calcCost('grok', 1_000_000, 1_000_000);
  // 5 USD за 1M input + 10 USD за 1M output = 15 USD ровно.
  assert.ok(near(cost, 15, 1e-9), `expected 15, got ${cost}`);
  delete process.env.XAI_INPUT_PRICE_USD_PER_1M;
  delete process.env.XAI_OUTPUT_PRICE_USD_PER_1M;
});

// ─────────────────────────────────────────────────────────────────────
// DashScope
// ─────────────────────────────────────────────────────────────────────

test('dashscope: известная модель qwen3.6-plus', () => {
  const cost = calcCost('dashscope', 10000, 2000, { model: 'qwen3.6-plus' });
  const rate = PRICES.dashscope['qwen3.6-plus'];
  const expected = 10000 * rate.input + 2000 * rate.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
});

test('dashscope: qwen-max — премиум-тариф', () => {
  const cost = calcCost('dashscope', 10000, 2000, { model: 'qwen-max' });
  const rate = PRICES.dashscope['qwen-max'];
  const expected = 10000 * rate.input + 2000 * rate.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
  // Sanity: qwen-max заведомо дороже qwen-plus при том же usage.
  const cheap = calcCost('dashscope', 10000, 2000, { model: 'qwen-plus' });
  assert.ok(cost > cheap, 'qwen-max должен быть дороже qwen-plus');
});

test('dashscope: неизвестная модель → fallback default + один warn', () => {
  // Перехватываем console.warn один раз, чтобы убедиться, что предупреждение действительно вылетает.
  const origWarn = console.warn;
  let warnCount = 0;
  console.warn = (...args) => { warnCount++; /* проглатываем */ };
  try {
    const cost1 = calcCost('dashscope', 1000, 500, { model: 'qwen-future-2050' });
    const cost2 = calcCost('dashscope', 1000, 500, { model: 'qwen-future-2050' });
    const rate  = PRICES.dashscope.default;
    const expected = 1000 * rate.input + 500 * rate.output;
    assert.ok(near(cost1, expected), `expected ${expected}, got ${cost1}`);
    assert.ok(near(cost2, expected), 'повторный вызов даёт ту же стоимость');
    assert.strictEqual(warnCount, 1, 'warn должен быть напечатан ровно один раз для модели');
  } finally {
    console.warn = origWarn;
  }
});

test('dashscope: usage без model → default-тариф (стоимость > 0)', () => {
  const cost = calcCost('dashscope', 1000, 500);
  const rate = PRICES.dashscope.default;
  const expected = 1000 * rate.input + 500 * rate.output;
  assert.ok(near(cost, expected), `expected ${expected}, got ${cost}`);
  assert.ok(cost > 0, 'DashScope без явной модели всё равно должен иметь стоимость > 0');
});

test('dashscope: env-override DASHSCOPE_QWEN_MAX_INPUT_PRICE_USD_PER_1M', () => {
  process.env.DASHSCOPE_QWEN_MAX_INPUT_PRICE_USD_PER_1M  = '10';
  process.env.DASHSCOPE_QWEN_MAX_OUTPUT_PRICE_USD_PER_1M = '20';
  const rate = _resolveDashscopeRate('qwen-max');
  assert.ok(near(rate.input,  10 / 1_000_000, 1e-15), `input rate from env, got ${rate.input}`);
  assert.ok(near(rate.output, 20 / 1_000_000, 1e-15), `output rate from env, got ${rate.output}`);
  delete process.env.DASHSCOPE_QWEN_MAX_INPUT_PRICE_USD_PER_1M;
  delete process.env.DASHSCOPE_QWEN_MAX_OUTPUT_PRICE_USD_PER_1M;
});

test('dashscope: имя модели регистро- и точко-нечувствительно (env normalisation)', () => {
  // env-key для "qwen3.6-plus" → "QWEN3_6_PLUS"
  process.env.DASHSCOPE_QWEN3_6_PLUS_INPUT_PRICE_USD_PER_1M  = '7';
  process.env.DASHSCOPE_QWEN3_6_PLUS_OUTPUT_PRICE_USD_PER_1M = '14';
  const rate = _resolveDashscopeRate('Qwen3.6-Plus');
  assert.ok(near(rate.input,  7 / 1_000_000, 1e-15));
  assert.ok(near(rate.output, 14 / 1_000_000, 1e-15));
  delete process.env.DASHSCOPE_QWEN3_6_PLUS_INPUT_PRICE_USD_PER_1M;
  delete process.env.DASHSCOPE_QWEN3_6_PLUS_OUTPUT_PRICE_USD_PER_1M;
});

// ─────────────────────────────────────────────────────────────────────
// Неизвестный провайдер
// ─────────────────────────────────────────────────────────────────────

test('unknown provider → 0 (BC, не падаем)', () => {
  const cost = calcCost('unknown-provider', 1000, 500);
  assert.strictEqual(cost, 0);
});

// ─────────────────────────────────────────────────────────────────────
// Запуск
// ─────────────────────────────────────────────────────────────────────

(async () => {
  let pass = 0, fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`✓ ${t.name}`);
    } catch (err) {
      fail++;
      console.error(`✗ ${t.name}\n   ${err.message}`);
    }
  }
  console.log(`\n${pass}/${tests.length} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
