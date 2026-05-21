/* eslint-disable no-console */
'use strict';

/**
 * test-quality-score.js — детерминированный smoke-тест qualityScore.js.
 * Никаких сетевых вызовов и БД.
 */

const {
  computeQualityScore,
  WEIGHTS,
} = require('../src/services/qualityLayers/qualityScore');

let failed = 0;
let passed = 0;
function ok(name, cond, details) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
}

console.log('\n=== test-quality-score ===\n');

// ── 1. Веса в сумме = 1.0 ────────────────────────────────────────────
{
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  ok(`weights sum to 1.0 (got ${sum.toFixed(3)})`, Math.abs(sum - 1.0) < 1e-9);
}

// ── 2. Все «pass» → ~100 ─────────────────────────────────────────────
{
  const result = computeQualityScore({
    eeat_audit:          { total_score: 10, verdict: 'pass' },
    readability_report:  { verdict: 'pass' },
    fact_check_report:   { verdict: 'pass', supportedPct: 100 },
    plagiarism_report:   { verdict: 'pass', overlapPctTotal: 0 },
    intent_verdict:      { verdict: 'pass' },
    lsi_report:          { coverage: 1.0 },
    image_qa_report:     { verdict: 'pass' },
    validation_report:   { issues: [] },
  }, { model_used: 'gemini-3.1-pro-preview', cost_usd: 0.5, generation_time_ms: 12345 });
  ok('all-pass overall ≈ 100', result.overall === 100, `got ${result.overall}`);
  ok('model_used echoed', result.model_used === 'gemini-3.1-pro-preview');
  ok('cost_usd preserved', result.cost_usd === 0.5);
  ok('generation_time_ms preserved', result.generation_time_ms === 12345);
  ok('computed_at present', typeof result.computed_at === 'string');
  ok('sub.eeat = 100', result.sub.eeat === 100);
  ok('sub.fact_check = 100', result.sub.fact_check === 100);
  ok('sub.plagiarism = 100', result.sub.plagiarism === 100);
}

// ── 3. Все «fail» → низкий overall ──────────────────────────────────
{
  const result = computeQualityScore({
    eeat_audit:          { total_score: 1, verdict: 'fail' },
    readability_report:  { verdict: 'refine' },
    fact_check_report:   { verdict: 'fail', supportedPct: 5 },
    plagiarism_report:   { verdict: 'fail', overlapPctTotal: 70 },
    intent_verdict:      { verdict: 'mismatch' },
    lsi_report:          { coverage: 0.1 },
    image_qa_report:     { verdict: 'fail' },
    validation_report:   { issues: new Array(20).fill({ kind: 'x' }) },
  }, { model_used: 'gemini-3.5-flash' });
  ok('all-fail overall < 35', result.overall < 35, `got ${result.overall}`);
  ok('sub.plagiarism = 0 at 70% overlap', result.sub.plagiarism === 0);
  ok('validation clamped at 30 for 20 issues', result.sub.validation === 30);
}

// ── 4. Все «na» → overall = null ────────────────────────────────────
{
  const result = computeQualityScore({
    eeat_audit:          null,
    readability_report:  { verdict: 'na' },
    fact_check_report:   { verdict: 'na' },
    plagiarism_report:   { verdict: 'na' },
    intent_verdict:      { verdict: 'na' },
    image_qa_report:     { verdict: 'na' },
  }, {});
  ok('all-na overall = null', result.overall === null, `got ${result.overall}`);
  ok('all-na sub.eeat = null', result.sub.eeat === null);
}

// ── 5. Веса перераспределяются при частичных данных ─────────────────
{
  // только E-E-A-T = 50, остальные null → overall должен быть 50
  const result = computeQualityScore({
    eeat_audit: { total_score: 5, verdict: 'review' },
  }, {});
  ok('partial data: overall = single subscore', result.overall === 50, `got ${result.overall}`);
  // applied_weights перенормированы
  const sumW = Object.values(result.applied_weights).reduce((a, b) => a + b, 0);
  ok('applied_weights normalized to ~1.0', Math.abs(sumW - 1.0) < 0.01,
     `sum=${sumW}`);
  ok('applied_weights.eeat = 1.0', Math.abs(result.applied_weights.eeat - 1.0) < 0.01);
}

// ── 6. lsi_overdose штрафует балл ───────────────────────────────────
{
  const high = computeQualityScore({
    lsi_report: { coverage: 1.0 },
  }, {});
  const low = computeQualityScore({
    lsi_report: { coverage: 1.0 },
    lsi_overdose_report: { zones: [{ verdict: 'overdose' }, { verdict: 'overdose' }] },
  }, {});
  ok('overdose lowers lsi subscore',
     low.sub.lsi < high.sub.lsi,
     `high=${high.sub.lsi}, low=${low.sub.lsi}`);
}

// ── 7. fact_check: supportedPct в [0..1] нормализуется в [0..100] ──
{
  const r = computeQualityScore({ fact_check_report: { verdict: 'pass', supportedPct: 0.85 } }, {});
  ok('fact_check supportedPct 0.85 → 85', r.sub.fact_check === 85);
}

// ── 8. eeat: total_score [0..10] → [0..100] ────────────────────────
{
  const r = computeQualityScore({ eeat_audit: { total_score: 7.5 } }, {});
  ok('eeat 7.5/10 → 75', r.sub.eeat === 75);
}

// ── 9. Невалидные meta → null ───────────────────────────────────────
{
  const r = computeQualityScore({ eeat_audit: { total_score: 5 } },
    { cost_usd: 'oops', generation_time_ms: NaN });
  ok('invalid cost_usd → null', r.cost_usd === null);
  ok('NaN generation_time_ms → null', r.generation_time_ms === null);
}

// ── 10. Пустые reports — overall=null, не падает ───────────────────
{
  const r = computeQualityScore({}, {});
  ok('empty reports overall=null', r.overall === null);
  ok('empty reports model_used=null', r.model_used === null);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
