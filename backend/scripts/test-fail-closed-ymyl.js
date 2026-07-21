'use strict';

/**
 * test-fail-closed-ymyl.js — юнит-тесты fail-closed политики Semantic
 * Fact-Check для YMYL-ниш (Итерация 2, Задача 3).
 *
 * Всё в памяти, без сети, без БД. Покрывает:
 *   • semanticFactcheckPolicy: resolveFailMode / shouldFailClosed / isYmylNiche
 *   • расписание ретраев planRetry (1/5/15 мин, затем manual_moderation)
 *   • orchestrateRetries: успех на N-й попытке; исчерпание → ручная модерация
 *   • метрики fail-closed: счётчик total + byNiche + byReason
 *   • checkSemanticFactcheck (quality gate checker):
 *       — YMYL + недоступный LLM (closed_ymyl) → blocker
 *       — не-YMYL + недоступный LLM (closed_ymyl) → warning (как сейчас)
 *       — YMYL + успешная семантика → без изменений (pass)
 *       — closed_all → blocker для любой ниши
 *   • qualityGate.finalize: сквозная интеграция blocker'а
 *   • factCheck.runSemanticFactCheck: аннотация semantic-блока (failClosed)
 *
 * Запуск:  node backend/scripts/test-fail-closed-ymyl.js
 */

const assert = require('assert');
const path = require('path');

const R = (...p) => require(path.join(__dirname, '..', 'src', 'services', ...p));

const policy = R('infoArticle', 'semanticFactcheckPolicy');
const { checkers, qualityGate } = R('qualityCore');
const factCheck = R('infoArticle', 'factCheck.service');
const contentPolicy = R('contentPolicy');

let _cases = 0, _pass = 0;
function check(name, fn) {
  _cases += 1;
  try {
    fn();
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.stack ? e.stack : e}`);
  }
}
async function checkAsync(name, fn) {
  _cases += 1;
  try {
    await fn();
    _pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.stack ? e.stack : e}`);
  }
}

async function main() {
  // Гарантируем предсказуемый env: не полагаемся на глобальный FACTCHECK_FAIL_MODE.
  delete process.env.FACTCHECK_FAIL_MODE;

  // ── Test 1: resolveFailMode ────────────────────────────────────────
  console.log('\n=== Test 1: resolveFailMode ===');
  check('default is open (no env, no override)', () => {
    assert.strictEqual(policy.resolveFailMode(), 'open');
  });
  check('override wins over env', () => {
    process.env.FACTCHECK_FAIL_MODE = 'closed_all';
    assert.strictEqual(policy.resolveFailMode('closed_ymyl'), 'closed_ymyl');
    delete process.env.FACTCHECK_FAIL_MODE;
  });
  check('env is read when no override', () => {
    process.env.FACTCHECK_FAIL_MODE = 'closed_ymyl';
    assert.strictEqual(policy.resolveFailMode(), 'closed_ymyl');
    delete process.env.FACTCHECK_FAIL_MODE;
  });
  check('unknown value falls back to open', () => {
    assert.strictEqual(policy.resolveFailMode('nonsense'), 'open');
    assert.strictEqual(policy.resolveFailMode(''), 'open');
  });

  // ── Test 2: shouldFailClosed matrix ────────────────────────────────
  console.log('\n=== Test 2: shouldFailClosed ===');
  check('open → never fail-closed', () => {
    assert.strictEqual(policy.shouldFailClosed({ failMode: 'open', isYmyl: true }), false);
    assert.strictEqual(policy.shouldFailClosed({ failMode: 'open', isYmyl: false }), false);
  });
  check('closed_ymyl → only YMYL', () => {
    assert.strictEqual(policy.shouldFailClosed({ failMode: 'closed_ymyl', isYmyl: true }), true);
    assert.strictEqual(policy.shouldFailClosed({ failMode: 'closed_ymyl', isYmyl: false }), false);
  });
  check('closed_all → any niche', () => {
    assert.strictEqual(policy.shouldFailClosed({ failMode: 'closed_all', isYmyl: true }), true);
    assert.strictEqual(policy.shouldFailClosed({ failMode: 'closed_all', isYmyl: false }), true);
  });

  // ── Test 3: isYmylNiche via contentPolicy config ───────────────────
  console.log('\n=== Test 3: YMYL niches from contentPolicy config ===');
  check('медицина / финансы / юр. / страхование detected', () => {
    assert.ok(policy.isYmylNiche('лечение диабета'));
    assert.ok(policy.isYmylNiche('потребительский кредит'));
    assert.ok(policy.isYmylNiche('юридическая консультация'));
    assert.ok(policy.isYmylNiche('страхование жизни'));
  });
  check('generic niche is not YMYL', () => {
    assert.strictEqual(policy.isYmylNiche('обзор пылесосов'), false);
  });
  check('YMYL list is editable via contentPolicy (not hardcoded in service)', () => {
    contentPolicy._setCacheForTest({ ymyl: ['криптовалют'] });
    assert.ok(policy.isYmylNiche('инвестиции в криптовалюту'));
    contentPolicy._resetCache();
  });

  // ── Test 4: retry schedule (planRetry) ─────────────────────────────
  console.log('\n=== Test 4: retry schedule 1/5/15 min ===');
  check('delays are 1/5/15 minutes for attempts 1..3', () => {
    assert.deepStrictEqual(policy.RETRY_DELAYS_MS, [60000, 300000, 900000]);
    assert.strictEqual(policy.MAX_RETRIES, 3);
    assert.strictEqual(policy.planRetry(1).delayMs, 60000);
    assert.strictEqual(policy.planRetry(2).delayMs, 300000);
    assert.strictEqual(policy.planRetry(3).delayMs, 900000);
  });
  check('attempts 1,2 are not final; attempt 3 is final retry', () => {
    assert.strictEqual(policy.planRetry(1).isFinal, false);
    assert.strictEqual(policy.planRetry(1).action, 'retry');
    assert.strictEqual(policy.planRetry(3).isFinal, true);
    assert.strictEqual(policy.planRetry(3).action, 'retry');
  });
  check('after exhaustion → manual_moderation', () => {
    const p = policy.planRetry(4);
    assert.strictEqual(p.action, 'manual_moderation');
    assert.strictEqual(p.delayMs, null);
    assert.strictEqual(p.isFinal, true);
  });

  // ── Test 5: orchestrateRetries ─────────────────────────────────────
  console.log('\n=== Test 5: orchestrateRetries ===');
  await checkAsync('retries run on schedule; success on 2nd attempt stops', async () => {
    const observed = [];
    let calls = 0;
    const res = await policy.orchestrateRetries({
      verify: async () => { calls += 1; return { ok: calls >= 2 }; },
      onScheduleRetry: (plan) => { observed.push(plan.delayMs); },
      sleep: async () => {}, // no-op: не ждём реальные минуты
    });
    assert.strictEqual(res.resolved, true);
    assert.strictEqual(res.attempts, 2);
    assert.deepStrictEqual(observed, [60000, 300000]);
  });
  await checkAsync('exhausted retries → manual moderation callback fired', async () => {
    const observed = [];
    let manual = null;
    const res = await policy.orchestrateRetries({
      verify: async () => ({ ok: false, reason: 'DeepSeek timeout' }),
      onScheduleRetry: (plan) => { observed.push(plan.delayMs); },
      onManualModeration: (info) => { manual = info; },
      sleep: async () => {},
    });
    assert.strictEqual(res.resolved, false);
    assert.strictEqual(res.attempts, 3);
    assert.strictEqual(res.action, 'manual_moderation');
    assert.deepStrictEqual(observed, [60000, 300000, 900000]);
    assert.ok(manual && manual.action === 'manual_moderation');
    assert.strictEqual(manual.reason, 'DeepSeek timeout');
  });

  // ── Test 6: fail-closed metrics ────────────────────────────────────
  console.log('\n=== Test 6: fail-closed metrics ===');
  check('recordFailClosed increments total + byNiche + byReason', () => {
    policy.resetFailClosedMetrics();
    policy.recordFailClosed({ niche: 'медицина', reason: 'timeout' });
    policy.recordFailClosed({ niche: 'медицина', reason: 'timeout' });
    policy.recordFailClosed({ niche: 'финансы', reason: 'invalid_json' });
    const m = policy.getFailClosedMetrics();
    assert.strictEqual(m.total, 3);
    assert.strictEqual(m.byNiche['медицина'], 2);
    assert.strictEqual(m.byNiche['финансы'], 1);
    assert.strictEqual(m.byReason['timeout'], 2);
    assert.strictEqual(m.byReason['invalid_json'], 1);
    policy.resetFailClosedMetrics();
  });

  // ── Test 7: checkSemanticFactcheck (quality gate checker) ──────────
  console.log('\n=== Test 7: checkSemanticFactcheck ===');
  check('YMYL + unavailable LLM (closed_ymyl) → blocker', () => {
    policy.resetFailClosedMetrics();
    const g = checkers.checkSemanticFactcheck(
      { semanticSkipped: true, reason: 'DeepSeek unavailable', isYmyl: true, niche: 'медицина' },
      { ymyl: true, failMode: 'closed_ymyl', niche: 'медицина' },
    );
    assert.strictEqual(g.name, 'semantic_factcheck');
    assert.strictEqual(g.pass, false);
    assert.strictEqual(g.blocking, true);
    assert.strictEqual(g.verdict, 'unavailable');
    assert.strictEqual(g.evidence.blocker, 'semantic_factcheck_unavailable');
    assert.strictEqual(policy.getFailClosedMetrics().total, 1);
    assert.strictEqual(policy.getFailClosedMetrics().byNiche['медицина'], 1);
    policy.resetFailClosedMetrics();
  });
  check('non-YMYL + unavailable LLM (closed_ymyl) → warning (fail-open, как сейчас)', () => {
    policy.resetFailClosedMetrics();
    const g = checkers.checkSemanticFactcheck(
      { semanticSkipped: true, reason: 'DeepSeek unavailable', isYmyl: false, niche: 'пылесосы' },
      { ymyl: false, failMode: 'closed_ymyl', niche: 'пылесосы' },
    );
    assert.strictEqual(g.pass, false);
    assert.strictEqual(g.blocking, false); // warning, не blocker
    assert.strictEqual(g.verdict, 'unavailable_warning');
    assert.strictEqual(policy.getFailClosedMetrics().total, 0);
  });
  check('YMYL + successful semantic → без изменений (pass, ran)', () => {
    const g = checkers.checkSemanticFactcheck(
      { semanticSkipped: false, unavailable: false, isYmyl: true },
      { ymyl: true, failMode: 'closed_ymyl', niche: 'медицина' },
    );
    assert.strictEqual(g.pass, true);
    assert.strictEqual(g.blocking, false);
    assert.strictEqual(g.verdict, 'ran');
  });
  check('closed_all → blocker even for non-YMYL', () => {
    policy.resetFailClosedMetrics();
    const g = checkers.checkSemanticFactcheck(
      { semanticSkipped: true, reason: 'timeout', isYmyl: false, niche: 'пылесосы' },
      { ymyl: false, failMode: 'closed_all', niche: 'пылесосы' },
    );
    assert.strictEqual(g.blocking, true);
    assert.strictEqual(g.verdict, 'unavailable');
    policy.resetFailClosedMetrics();
  });
  check('open mode → never blocks (default behaviour)', () => {
    const g = checkers.checkSemanticFactcheck(
      { semanticSkipped: true, reason: 'timeout', isYmyl: true, niche: 'медицина' },
      { ymyl: true, failMode: 'open', niche: 'медицина' },
    );
    assert.strictEqual(g.blocking, false);
    assert.strictEqual(g.verdict, 'unavailable_warning');
  });
  check('no semantic report → na (pass, no block)', () => {
    const g = checkers.checkSemanticFactcheck(null, { ymyl: true, failMode: 'closed_all' });
    assert.strictEqual(g.pass, true);
    assert.strictEqual(g.blocking, false);
    assert.strictEqual(g.verdict, 'na');
  });

  // ── Test 8: qualityGate.finalize integration ───────────────────────
  console.log('\n=== Test 8: qualityGate.finalize integration ===');
  check('YMYL niche + unavailable semantic → gate blocks (canPublish=false)', () => {
    policy.resetFailClosedMetrics();
    const res = qualityGate.finalize('info', {
      html: '<p>Статья про лечение.</p>',
      niche: 'лечение простуды',
      semanticFactcheck: { semanticSkipped: true, reason: 'DeepSeek timeout', isYmyl: true },
    }, { failMode: 'closed_ymyl' });
    assert.strictEqual(res.ymyl, true);
    assert.strictEqual(res.canPublish, false);
    const blocker = res.blockers.find((b) => b.name === 'semantic_factcheck');
    assert.ok(blocker, 'expected semantic_factcheck blocker');
    assert.strictEqual(blocker.verdict, 'unavailable');
    policy.resetFailClosedMetrics();
  });
  check('non-YMYL niche + unavailable semantic → warning only (canPublish=true)', () => {
    const res = qualityGate.finalize('info', {
      html: '<p>Обзор пылесосов.</p>',
      niche: 'обзор пылесосов',
      semanticFactcheck: { semanticSkipped: true, reason: 'DeepSeek timeout', isYmyl: false },
    }, { failMode: 'closed_ymyl' });
    assert.strictEqual(res.ymyl, false);
    const sem = res.gates.find((g) => g.name === 'semantic_factcheck');
    assert.ok(sem && sem.blocking === false, 'semantic must be warning, not blocker');
    const semBlocker = res.blockers.find((b) => b.name === 'semantic_factcheck');
    assert.ok(!semBlocker, 'no semantic blocker expected for non-YMYL');
  });

  // ── Test 9: factCheck.runSemanticFactCheck annotation ──────────────
  console.log('\n=== Test 9: runSemanticFactCheck fail-mode annotation ===');
  await checkAsync('unavailable semantic (no DEEPSEEK key) → semantic.failClosed for YMYL', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY; // форсируем skipped semantic
    try {
      const evidence = { evidence: [{ url: 'https://ex.com', snippets: [{ text: 'что-то' }] }] };
      const html = '<p>Аспирин — это лекарственный препарат, который применяется при простуде и боли.</p>';
      const out = await factCheck.runSemanticFactCheck(html, evidence, {
        niche: 'лечение простуды', failMode: 'closed_ymyl',
      });
      assert.ok(out.semantic, 'semantic block present');
      assert.strictEqual(out.semantic.failMode, 'closed_ymyl');
      assert.strictEqual(out.semantic.isYmyl, true);
      assert.strictEqual(out.semantic.unavailable, true);
      assert.strictEqual(out.semantic.failClosed, true);
      const gate = qualityGate.finalize('info', {
        html, niche: 'лечение простуды', factReport: out,
      }, { failMode: 'closed_ymyl' });
      policy.resetFailClosedMetrics();
      assert.strictEqual(gate.canPublish, false);
    } finally {
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    }
  });
  await checkAsync('non-YMYL niche → failClosed=false even when unavailable', async () => {
    const savedKey = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const evidence = { evidence: [{ url: 'https://ex.com', snippets: [{ text: 'что-то' }] }] };
      const html = '<p>Пылесос весит 3 кг и стоит 9990 рублей.</p>';
      const out = await factCheck.runSemanticFactCheck(html, evidence, {
        niche: 'обзор пылесосов', failMode: 'closed_ymyl',
      });
      assert.strictEqual(out.semantic.isYmyl, false);
      assert.strictEqual(out.semantic.failClosed, false);
    } finally {
      if (savedKey !== undefined) process.env.DEEPSEEK_API_KEY = savedKey;
    }
  });

  // ── Итог ────────────────────────────────────────────────────────────
  console.log('\n────────────────────────────────────────────────────────────');
  if (_pass === _cases) {
    console.log(`✅ All ${_cases} fail-closed YMYL tests passed`);
  } else {
    console.log(`❌ ${_cases - _pass}/${_cases} fail-closed YMYL tests FAILED`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
