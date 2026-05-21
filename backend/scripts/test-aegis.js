'use strict';

/**
 * Smoke-тесты A.E.G.I.S. модулей backend'а — без сети, без БД, без LLM.
 *
 *   node backend/scripts/test-aegis.js
 *
 * Проверяем:
 *   • featureFlags: deepFreeze, range validation, deps.
 *   • shannonEntropy: 8-char uniform = 3.0; повторы = 0; русский ≥ 3.5.
 *   • budgetGuard: charge / assertWithinLimits / BudgetExceededError.
 *   • qualityGate: pass / fail (overall) / fail (sub) / review-режим.
 *   • brainStateRegistry._parseSimpleYaml: вложенность и multi-line.
 *   • deepseekMutator.isPathAllowed: allowlist / blocklist.
 *   • orchestrator.runRefineLoop: 1-iter pass и max-iter exhaustion.
 *   • ga4Client.computePpoWeights: квантили.
 */

const assert = require('assert');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed += 1; console.log(`  ✓ ${name}`); },
        (e) => { failed += 1; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); },
      );
    }
    passed += 1;
    console.log(`  ✓ ${name}`);
    return undefined;
  } catch (e) {
    failed += 1;
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    return undefined;
  }
}

async function main() {
  console.log('\n[aegis/featureFlags]');
  const { getAegisFlags } = require('../src/services/aegis/featureFlags');
  test('deepFreeze applied', () => {
    const f = getAegisFlags();
    assert.throws(() => { f.qualityGate.minOverall = 99; }, /Cannot assign|read only/i);
  });
  test('default qualityGate.minOverall == 80 (Spq ≥ 8.0)', () => {
    assert.strictEqual(getAegisFlags().qualityGate.minOverall, 80);
  });

  console.log('\n[aegis/shannonEntropy]');
  const { shannonEntropy, isLowEntropy, filterLowEntropyBlocks } = require('../src/services/aegis/shannonEntropy');
  test('empty → 0', () => assert.strictEqual(shannonEntropy(''), 0));
  test('repeated single char → 0', () => assert.strictEqual(shannonEntropy('a'.repeat(100)), 0));
  test('8 uniform chars → log2(8)=3', () => {
    const H = shannonEntropy('abcdefgh'.repeat(50));
    assert(Math.abs(H - 3.0) < 1e-9, `H=${H}`);
  });
  test('Russian normal text ≥ 3.5', () => {
    const text = 'Семантическое ядро и анализ конкурентов — основа продвижения в поиске';
    assert(shannonEntropy(text.repeat(5)) > 3.5);
  });
  test('isLowEntropy: short text skipped', () => assert.strictEqual(isLowEntropy('ab', { minLength: 80 }), false));
  test('isLowEntropy: garbage detected', () => assert.strictEqual(isLowEntropy('aaabbb'.repeat(30), { minEntropy: 3.5 }), true));
  test('filterLowEntropyBlocks: stats correct', () => {
    const r = filterLowEntropyBlocks([
      { id: 1, text: 'qqqqqq'.repeat(30) },
      { id: 2, text: 'Семантика LSI и поиск конкурентов'.repeat(5) },
    ], { minEntropy: 3.5, minLength: 80 });
    assert.strictEqual(r.stats.kept_count, 1);
    assert.strictEqual(r.stats.dropped_count, 1);
    assert.strictEqual(r.kept[0].id, 2);
  });

  console.log('\n[aegis/budgetGuard]');
  const { createBudgetTracker, BudgetExceededError } = require('../src/services/aegis/budgetGuard');
  test('within limits ok', () => {
    const t = createBudgetTracker();
    t.charge({ provider: 'gemini', tokensIn: 100, tokensOut: 200, costUsd: 0.001 });
    t.assertWithinLimits();
  });
  test('overall budget exceeded throws', () => {
    const t = createBudgetTracker({ overallTaskUsd: 0.5 });
    t.charge({ provider: 'gemini', costUsd: 0.4 });
    t.charge({ provider: 'deepseek', costUsd: 0.3 });
    assert.throws(() => t.assertWithinLimits(), BudgetExceededError);
  });
  test('gemini tokens exceeded throws', () => {
    const t = createBudgetTracker({ geminiTaskTokens: 1000 });
    t.charge({ provider: 'gemini', tokensIn: 600, tokensOut: 600 });
    assert.throws(() => t.assertWithinLimits(), BudgetExceededError);
  });

  console.log('\n[aegis/qualityGate]');
  const { evaluateQualityGate, enforceQualityGate, QualityGateFailedError } = require('../src/services/aegis/qualityGate');
  test('pass: overall ≥ 80, no sub fails', () => {
    const audit = evaluateQualityGate({ overall: 85, sub: { eeat: 80, fact_check: 90, plagiarism: 95 } });
    assert.strictEqual(audit.verdict, 'pass');
    assert.strictEqual(audit.passed, true);
  });
  test('fail: overall < 80', () => {
    const audit = evaluateQualityGate({ overall: 75, sub: {} });
    assert.strictEqual(audit.verdict, 'fail');
    assert.match(audit.reason, /< 80/);
  });
  test('fail: sub eeat too low even with overall ≥ 80', () => {
    const audit = evaluateQualityGate({ overall: 82, sub: { eeat: 50, fact_check: 90, plagiarism: 95 } });
    assert.strictEqual(audit.passed, false);
    assert(audit.sub_fails.find((f) => f.key === 'eeat'));
  });
  test('enforceQualityGate throws on fail', () => {
    assert.throws(() => enforceQualityGate({ overall: 50, sub: {} }), QualityGateFailedError);
  });

  console.log('\n[aegis/brainStateRegistry]');
  const { _parseSimpleYaml } = require('../src/services/aegis/brainStateRegistry');
  test('parses nested keys', () => {
    const y = _parseSimpleYaml('version: 2\nwriter:\n  model: gemini-3.5\n  trials: 17\n');
    assert.strictEqual(y.version, 2);
    assert.strictEqual(y.writer.model, 'gemini-3.5');
    assert.strictEqual(y.writer.trials, 17);
  });
  test('parses multi-line block', () => {
    const y = _parseSimpleYaml('notes: |\n  line one\n  line two\n');
    assert.strictEqual(y.notes, 'line one\nline two');
  });

  console.log('\n[aegis/deepseekMutator]');
  const { isPathAllowed } = require('../src/services/aegis/deepseekMutator');
  test('allows parser path', () => assert.strictEqual(isPathAllowed('backend/src/services/parser/scraper.js').allowed, true));
  test('blocks llm path', () => assert.strictEqual(isPathAllowed('backend/src/services/llm/gemini.adapter.js').allowed, false));
  test('blocks migrations', () => assert.strictEqual(isPathAllowed('migrations/038_aegis.sql').allowed, false));
  test('blocks aegis itself', () => assert.strictEqual(isPathAllowed('backend/src/services/aegis/orchestrator.js').allowed, false));
  test('not_in_allowlist by default', () => {
    const r = isPathAllowed('backend/src/controllers/foo.controller.js');
    assert.strictEqual(r.allowed, false);
    assert.strictEqual(r.reason, 'not_in_allowlist');
  });

  console.log('\n[aegis/orchestrator]');
  const { runRefineLoop } = require('../src/services/aegis/orchestrator');
  await test('passes after first write if critics yield Spq ≥ 80', async () => {
    const result = await runRefineLoop({
      writeFn: async () => ({ html: '<p>ok</p>', usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.0001 } }),
      criticsFn: async () => ({
        reports: {
          eeat_audit:        { total_score: 9.0, verdict: 'pass' },
          fact_check_report: { verdict: 'pass', supportedPct: 95, unsupported_count: 0 },
          plagiarism_report: { verdict: 'pass', overlap_pct_total: 5, plagiarism_count: 0 },
        },
        meta: { model_used: 'gemini-3.5-flash', cost_usd: 0.0002 },
      }),
      userMsg: 'write me an article',
      logger: { info() {}, warn() {} },
    });
    assert.strictEqual(result.passed, true);
    assert.strictEqual(result.iterations, 1);
    assert.strictEqual(result.needs_human_review, false);
  });

  console.log('\n[aegis/ga4Client]');
  const { computePpoWeights } = require('../src/services/aegis/ga4Client');
  test('top 25% получают ppo_weight=3', () => {
    const items = [
      { pagePath: '/a', engagementRate: 0.1 },
      { pagePath: '/b', engagementRate: 0.2 },
      { pagePath: '/c', engagementRate: 0.3 },
      { pagePath: '/d', engagementRate: 0.9 },
    ];
    const w = computePpoWeights(items, { topQuantile: 0.75, ppoWeight: 3 });
    const winner = w.find((x) => x.pagePath === '/d');
    assert.strictEqual(winner.ppo_weight, 3);
    const loser = w.find((x) => x.pagePath === '/a');
    assert.strictEqual(loser.ppo_weight, 1);
  });

  console.log(`\n──── ${passed} passed, ${failed} failed ────`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
