'use strict';

/**
 * test-aegis-llm-usage.js — смоук-тесты для aegis/llmUsageLog.js
 * (посуточный учёт расходов Эгиды → таблица aegis_llm_usage).
 *
 * Всё в памяти: реальная БД не требуется. Подменяем модуль ../config/db в
 * require-кэше фейковым клиентом, чтобы проверить:
 *   • recordUsage никогда не бросает (best-effort);
 *   • при выключенном флаге costLog.enabled — no-op (reason: 'disabled');
 *   • при включённом флаге — один параметризованный INSERT с корректной
 *     нормализацией полей (clamp отрицательных токенов, cache_hit из
 *     cachedTokens, обрезка длинных строк, дефолт outcome='ok');
 *   • сбой db.query → reason: 'db_error', без исключения наружу.
 *
 * Запуск:  node backend/scripts/test-aegis-llm-usage.js
 */

const assert = require('assert');
const path   = require('path');
const Module = require('module');

const DB_PATH = path.join(__dirname, '..', 'src', 'config', 'db.js');
const FLAGS_PATH = path.join(__dirname, '..', 'src', 'services', 'aegis', 'featureFlags.js');
const USAGE_PATH = path.join(__dirname, '..', 'src', 'services', 'aegis', 'llmUsageLog.js');

// ── Фейковый db в require-кэше ─────────────────────────────────────
const _calls = [];
let _throwNext = false;
function _installFakeDb() {
  const id = require.resolve(DB_PATH);
  const m = new Module(id, module);
  m.filename = id;
  m.loaded = true;
  m.exports = {
    query: async (text, params) => {
      _calls.push({ text, params });
      if (_throwNext) { _throwNext = false; throw new Error('relation "aegis_llm_usage" does not exist'); }
      return { rows: [], rowCount: 1 };
    },
  };
  require.cache[id] = m;
}

function _freshUsage() {
  delete require.cache[require.resolve(USAGE_PATH)];
  return require(USAGE_PATH);
}

function _setFlagEnabled(enabled) {
  // Загружаем реальные флаги и патчим costLog.enabled через переопределение
  // getAegisFlags в кэше модуля.
  const id = require.resolve(FLAGS_PATH);
  delete require.cache[id];
  const real = require(FLAGS_PATH);
  const base = real.getAegisFlags();
  const patched = { ...base, costLog: { ...(base.costLog || {}), enabled } };
  real.getAegisFlags = () => patched;
}

let passed = 0;
function ok(name) { passed += 1; console.log(`  ✓ ${name}`); }

(async () => {
  _installFakeDb();

  // 1. Выключенный флаг → no-op.
  _setFlagEnabled(false);
  let usage = _freshUsage();
  _calls.length = 0;
  let r = await usage.recordUsage({ provider: 'deepseek', tokensIn: 10 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'disabled');
  assert.strictEqual(_calls.length, 0, 'disabled flag must not touch db');
  ok('disabled flag → no INSERT, reason=disabled');

  // 2. Включённый флаг → один INSERT с нормализацией.
  _setFlagEnabled(true);
  usage = _freshUsage();
  _calls.length = 0;
  r = await usage.recordUsage({
    provider: 'DeepSeek',
    kind: 'writer',
    tokensIn: 1000,
    tokensOut: 250,
    cachedTokens: 400,
    costUsd: 0.0123,
    latencyMs: 1500,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(_calls.length, 1, 'exactly one INSERT');
  const c = _calls[0];
  assert.ok(/INSERT INTO aegis_llm_usage/.test(c.text), 'INSERT statement');
  assert.ok(/\$1.*\$9/s.test(c.text), 'parameterized ($1..$9)');
  const p = c.params;
  assert.strictEqual(p[0], 'deepseek', 'provider lowercased');
  assert.strictEqual(p[1], 'writer', 'kind');
  assert.strictEqual(p[2], 'ok', 'default outcome');
  assert.strictEqual(p[3], 1000, 'tokens_in');
  assert.strictEqual(p[4], 250, 'tokens_out');
  assert.strictEqual(p[5], 400, 'cached_tokens');
  assert.strictEqual(p[6], 0.0123, 'cost_usd');
  assert.strictEqual(p[7], true, 'cache_hit derived from cachedTokens>0');
  assert.strictEqual(p[8], 1500, 'latency_ms');
  ok('enabled flag → single parameterized INSERT with normalized fields');

  // 3. Нормализация: отрицательные/NaN → 0, нет кэша → cache_hit=false,
  //    длинный provider обрезается, явный outcome сохраняется.
  _calls.length = 0;
  r = await usage.recordUsage({
    provider: 'x'.repeat(50),
    tokensIn: -5,
    tokensOut: NaN,
    cachedTokens: 0,
    costUsd: -1,
    outcome: 'error',
  });
  assert.strictEqual(r.ok, true);
  const p3 = _calls[0].params;
  assert.strictEqual(p3[0].length, 32, 'provider clamped to 32 chars');
  assert.strictEqual(p3[2], 'error', 'explicit outcome preserved');
  assert.strictEqual(p3[3], 0, 'negative tokens_in → 0');
  assert.strictEqual(p3[4], 0, 'NaN tokens_out → 0');
  assert.strictEqual(p3[5], 0, 'cached_tokens 0');
  assert.strictEqual(p3[6], 0, 'negative cost → 0');
  assert.strictEqual(p3[7], false, 'no cache → cache_hit=false');
  assert.strictEqual(p3[8], null, 'missing latency → null');
  ok('field normalization (clamp, outcome, cache_hit, latency null)');

  // 4. Сбой db.query → reason db_error, без исключения.
  _calls.length = 0;
  _throwNext = true;
  r = await usage.recordUsage({ provider: 'gemini', tokensIn: 1 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'db_error');
  ok('db error swallowed → reason=db_error (never throws)');

  console.log(`\nAll aegis llm-usage tests passed (${passed} checks).`);
})().catch((e) => {
  console.error('TEST FAILED:', e && e.stack ? e.stack : e);
  process.exit(1);
});
