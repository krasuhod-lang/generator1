'use strict';

/**
 * test-funnel-tracker.js — детерминированные смоук-тесты для
 * aegis/funnelTracker.js (учёт успешных/неуспешных «связок» генерации).
 *
 * Всё в памяти, без сети и без БД (persist при выключенном флаге — no-op).
 * Покрывает:
 *   • classifyReason: сетевые/LLM/парсинг/таймаут/бюджет ошибки + фолбэк на
 *     валидатор writer'а + 'other' + null для пустого ввода;
 *   • Stepper API: step() закрывает предыдущую стадию как ok, fail() — как fail,
 *     finish() закрывает последнюю и (опц.) персистит;
 *   • toReport: by_outcome, final_stage, fail_reason, агрегаты cost/tokens/retries;
 *   • runStage: ok / throw(fail+rethrow) / optional(skip, без rethrow);
 *   • persist: безопасный no-op при выключенном флаге (никогда не бросает);
 *   • идемпотентность toReport (повторный вызов не дублирует стадии).
 *
 * Запуск:  node backend/scripts/test-funnel-tracker.js
 */

const assert = require('assert');
const path   = require('path');

const {
  createFunnelTracker,
  recordTaskFunnel,
  classifyReason,
  ERROR_PATTERNS,
} = require(path.join(__dirname, '..', 'src', 'services', 'aegis', 'funnelTracker'));

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try {
    fn();
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
  }
}
function checkAsync(name, fn) {
  return (async () => {
    _cases += 1;
    try {
      await fn();
      _pass += 1;
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
    }
  })();
}

// ── Test 1: classifyReason ───────────────────────────────────────────
console.log('\n=== Test 1: classifyReason ===');

check('null/empty → null', () => {
  assert.strictEqual(classifyReason(null), null);
  assert.strictEqual(classifyReason(''), null);
  assert.strictEqual(classifyReason('   '), null);
});
check('timeout patterns', () => {
  assert.strictEqual(classifyReason('Request timed out'), 'timeout');
  assert.strictEqual(classifyReason('ETIMEDOUT'), 'timeout');
});
check('rate_limit patterns', () => {
  assert.strictEqual(classifyReason('429 Too Many Requests'), 'rate_limit');
  assert.strictEqual(classifyReason('quota exceeded'), 'rate_limit');
});
check('auth patterns', () => {
  assert.strictEqual(classifyReason('401 Unauthorized'), 'auth');
  assert.strictEqual(classifyReason('invalid api key'), 'auth');
});
check('network patterns', () => {
  assert.strictEqual(classifyReason('ECONNRESET'), 'network');
  assert.strictEqual(classifyReason('fetch failed'), 'network');
});
check('parse_error patterns', () => {
  assert.strictEqual(classifyReason('Unexpected token in JSON'), 'parse_error');
});
check('empty_output patterns', () => {
  assert.strictEqual(classifyReason('empty response from model'), 'empty_output');
});
check('budget patterns', () => {
  assert.strictEqual(classifyReason('budget exceeded — kill switch'), 'budget');
});
check('Error instance accepted', () => {
  assert.strictEqual(classifyReason(new Error('socket hang up')), 'network');
});
check('unknown text → other', () => {
  assert.strictEqual(classifyReason('completely unrelated gibberish xyz'), 'other');
});
check('ERROR_PATTERNS is a non-empty array', () => {
  assert.ok(Array.isArray(ERROR_PATTERNS) && ERROR_PATTERNS.length >= 8);
});

// ── Test 2: Stepper API + toReport (success path) ────────────────────
console.log('\n=== Test 2: Stepper success path ===');

check('step() closes previous stage as ok; finish ok', () => {
  const f = createFunnelTracker({ kind: 'info_article', taskRef: 't1' });
  f.step('build_prompt');
  f.step('llm_generation');
  f.step('finalize');
  const rep = f.toReport({ status: 'completed' });
  assert.strictEqual(rep.kind, 'info_article');
  assert.strictEqual(rep.status, 'completed');
  // build_prompt + llm_generation закрыты как ok; finalize ещё открыт (не в stages).
  assert.strictEqual(rep.by_outcome.ok, 2);
  assert.strictEqual(rep.by_outcome.fail, 0);
  assert.strictEqual(rep.fail_reason, null);
});

// ── Test 3: Stepper API fail path ────────────────────────────────────
console.log('\n=== Test 3: Stepper fail path ===');

check('fail() closes current open stage as fail; final_stage + reason set', () => {
  const f = createFunnelTracker({ kind: 'meta_tags', taskRef: 't2' });
  f.step('audience_niche');
  f.step('generate_meta');
  f.fail(new Error('429 rate limit hit'));
  const rep = f.toReport();
  assert.strictEqual(rep.status, 'failed');
  assert.strictEqual(rep.final_stage, 'generate_meta');
  assert.strictEqual(rep.fail_reason, 'rate_limit');
  assert.strictEqual(rep.by_outcome.fail, 1);
  assert.strictEqual(rep.by_outcome.ok, 1); // audience_niche закрыт как ok
});

check('finish({error}) closes last open stage as fail', () => {
  const f = createFunnelTracker({ kind: 'relevance', taskRef: 't3' });
  f.step('serp');
  f.step('analyzing');
  const rep = f.toReport({ status: 'failed', error: new Error('parse error: bad JSON') });
  // toReport не закрывает открытую стадию, но fail_reason берётся из error.
  assert.strictEqual(rep.status, 'failed');
  assert.strictEqual(rep.fail_reason, 'parse_error');
});

// ── Test 4: aggregates (cost/tokens/retries) ─────────────────────────
console.log('\n=== Test 4: aggregates ===');

check('recordStage aggregates cost/tokens/retries', () => {
  const f = createFunnelTracker({ kind: 'forecaster', taskRef: 't4' });
  f.recordStage('a', { outcome: 'ok', costUsd: 0.01, tokensIn: 100, tokensOut: 50 });
  f.recordStage('b', { outcome: 'ok', costUsd: 0.02, tokensIn: 200, tokensOut: 80, attempts: 3 });
  f.recordStage('c', { outcome: 'skipped' });
  const rep = f.toReport({ status: 'completed' });
  assert.ok(Math.abs(rep.total_cost_usd - 0.03) < 1e-9, `cost=${rep.total_cost_usd}`);
  assert.strictEqual(rep.total_tokens_in, 300);
  assert.strictEqual(rep.total_tokens_out, 130);
  assert.strictEqual(rep.total_retries, 2); // attempts=3 → +2
  assert.strictEqual(rep.by_outcome.ok, 2);
  assert.strictEqual(rep.by_outcome.skipped, 1);
  assert.strictEqual(rep.stage_count, 3);
});

check('toReport is idempotent (does not duplicate stages)', () => {
  const f = createFunnelTracker({ kind: 'article_topics', taskRef: 't5' });
  f.recordStage('x', { outcome: 'ok' });
  const r1 = f.toReport({ status: 'completed' });
  const r2 = f.toReport({ status: 'completed' });
  assert.strictEqual(r1.stage_count, 1);
  assert.strictEqual(r2.stage_count, 1);
});

// ── Test 5: runStage wrapper ─────────────────────────────────────────
console.log('\n=== Test 5: runStage ===');

const t5 = checkAsync('runStage ok records ok', async () => {
  const f = createFunnelTracker({ kind: 'info_article', taskRef: 't6' });
  const out = await f.runStage('s1', async () => 42);
  assert.strictEqual(out, 42);
  const rep = f.toReport({ status: 'completed' });
  assert.strictEqual(rep.by_outcome.ok, 1);
});

const t6 = checkAsync('runStage rethrows and records fail', async () => {
  const f = createFunnelTracker({ kind: 'info_article', taskRef: 't7' });
  let threw = false;
  try {
    await f.runStage('s1', async () => { throw new Error('ECONNREFUSED'); });
  } catch (_e) { threw = true; }
  assert.ok(threw, 'expected rethrow');
  const rep = f.toReport();
  assert.strictEqual(rep.by_outcome.fail, 1);
  assert.strictEqual(rep.fail_reason, 'network');
});

const t7 = checkAsync('runStage optional → skipped, no rethrow, fallback returned', async () => {
  const f = createFunnelTracker({ kind: 'info_article', taskRef: 't8' });
  const out = await f.runStage('opt', async () => { throw new Error('boom'); }, { optional: true, fallback: 'fb' });
  assert.strictEqual(out, 'fb');
  const rep = f.toReport({ status: 'completed' });
  assert.strictEqual(rep.by_outcome.skipped, 1);
  assert.strictEqual(rep.by_outcome.fail, 0);
});

// ── Test 6: persist no-op safety ─────────────────────────────────────
console.log('\n=== Test 6: persist no-op safety ===');

const t8 = checkAsync('persist never throws; returns {ok:false} when disabled or no db', async () => {
  const f = createFunnelTracker({ kind: 'meta_tags', taskRef: 't9' });
  f.recordStage('a', { outcome: 'ok' });
  const res = await f.persist({ status: 'completed' });
  assert.ok(res && typeof res === 'object');
  assert.strictEqual(res.ok, false);
  assert.ok(res.report && res.report.kind === 'meta_tags');
});

const t9 = checkAsync('finish() returns persist result and never throws', async () => {
  const f = createFunnelTracker({ kind: 'relevance', taskRef: 't10' });
  f.step('serp');
  const res = await f.finish({ status: 'completed' });
  assert.ok(res && typeof res === 'object');
  assert.strictEqual(res.ok, false); // disabled/no-db in test env
});

const t10 = checkAsync('recordTaskFunnel facade returns persist result', async () => {
  const res = await recordTaskFunnel({
    kind: 'forecaster', taskRef: 't11', status: 'failed', error: new Error('timeout'),
  });
  assert.ok(res && typeof res === 'object');
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.report.status, 'failed');
  assert.strictEqual(res.report.fail_reason, 'timeout');
});

// ── Финал ────────────────────────────────────────────────────────────
Promise.all([t5, t6, t7, t8, t9, t10]).then(() => {
  console.log('\n' + '─'.repeat(60));
  if (_pass === _cases) {
    console.log(`✅ All ${_cases} funnelTracker tests passed`);
    process.exit(0);
  } else {
    console.log(`❌ ${_cases - _pass}/${_cases} funnelTracker tests failed`);
    process.exit(1);
  }
});
