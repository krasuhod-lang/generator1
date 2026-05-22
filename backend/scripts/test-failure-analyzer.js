'use strict';

/**
 * Smoke test для backend/src/services/aegis/failureAnalyzer.js.
 * Запуск: node backend/scripts/test-failure-analyzer.js
 *
 * Чисто unit, без БД/сети — детерминированный mapper reports → symptoms.
 */

const assert = require('assert');
const {
  analyzeFailures,
  _analyzeFactCheck,
  _analyzePlagiarism,
  _analyzeReadability,
  _analyzeIntent,
  _analyzeLsi,
  _analyzeEeat,
  _analyzeImageQa,
  _analyzeValidation,
  _findTopFailureLayer,
  DEFAULT_THRESHOLDS,
} = require('../src/services/aegis/failureAnalyzer');

let passed = 0;
let failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); failed++; }
}

const TH = DEFAULT_THRESHOLDS;

console.log('--- fact_check ---');
t('high unsupported pct triggers unsupported_numbers', () => {
  const out = _analyzeFactCheck({ verdict: 'review', unsupportedPctTotal: 45 }, TH);
  assert(out.some((s) => s.symptom === 'unsupported_numbers'));
});
t('verdict=fail triggers fact_check_failed', () => {
  const out = _analyzeFactCheck({ verdict: 'fail', score: 50 }, TH);
  assert(out.some((s) => s.symptom === 'fact_check_failed'));
});
t('pass with low unsupported = no symptoms', () => {
  const out = _analyzeFactCheck({ verdict: 'pass', unsupportedPctTotal: 5, score: 90 }, TH);
  assert.deepEqual(out, []);
});
t('na report returns empty', () => {
  assert.deepEqual(_analyzeFactCheck(null, TH), []);
});

console.log('--- plagiarism ---');
t('overlap 50% triggers paraphrase_too_close', () => {
  const out = _analyzePlagiarism({ verdict: 'review', overlapPctTotal: 50 }, TH);
  assert(out.some((s) => s.symptom === 'paraphrase_too_close'));
});
t('fail verdict + count triggers verbatim_copy', () => {
  const out = _analyzePlagiarism({ verdict: 'fail', overlapPctTotal: 70, plagiarismCount: 3 }, TH);
  assert(out.some((s) => s.symptom === 'verbatim_copy'));
});

console.log('--- readability ---');
t('passive 30% triggers too_passive', () => {
  const out = _analyzeReadability({ passivePct: 30 }, TH);
  assert(out.some((s) => s.symptom === 'too_passive'));
});
t('bureaucratese 20% triggers bureaucratese_overload', () => {
  const out = _analyzeReadability({ bureaucratesePct: 20 }, TH);
  assert(out.some((s) => s.symptom === 'bureaucratese_overload'));
});
t('passive 10% returns no symptom', () => {
  const out = _analyzeReadability({ passivePct: 10, bureaucratesePct: 5 }, TH);
  assert.deepEqual(out, []);
});

console.log('--- intent ---');
t('mismatch triggers wrong_intent_shape', () => {
  const out = _analyzeIntent({ verdict: 'mismatch' }, TH);
  assert(out.some((s) => s.symptom === 'wrong_intent_shape'));
});
t('review triggers intent_drift', () => {
  const out = _analyzeIntent({ verdict: 'review', score: 60 }, TH);
  assert(out.some((s) => s.symptom === 'intent_drift'));
});
t('pass returns empty', () => {
  assert.deepEqual(_analyzeIntent({ verdict: 'pass', score: 95 }, TH), []);
});

console.log('--- lsi ---');
t('coverage 0.4 triggers missing_lsi', () => {
  const out = _analyzeLsi({ coverage: 0.4, missing: ['x', 'y', 'z'] }, TH);
  const s = out.find((x) => x.symptom === 'missing_lsi');
  assert(s);
  assert.deepEqual(s.missing, ['x', 'y', 'z']);
});
t('coverage 0.7 = empty', () => {
  assert.deepEqual(_analyzeLsi({ coverage: 0.7 }, TH), []);
});
t('coverage in percent 40 normalises to 0.4', () => {
  const out = _analyzeLsi({ coverage: 40 }, TH);
  assert(out.some((s) => s.symptom === 'missing_lsi'));
});

console.log('--- eeat ---');
t('low experience triggers lacks_personal_experience', () => {
  const out = _analyzeEeat({ subscores: { experience: 4, expertise: 8, authority: 8, trust: 8 } }, TH);
  assert(out.some((s) => s.symptom === 'lacks_personal_experience'));
});
t('all high returns empty', () => {
  const out = _analyzeEeat({ subscores: { experience: 9, expertise: 9, authority: 9, trust: 9 } }, TH);
  assert.deepEqual(out, []);
});

console.log('--- image_qa ---');
t('cover=error triggers bad_cover_image', () => {
  const out = _analyzeImageQa({ verdict: 'fail', slots: [{ slot: 1, status: 'error' }] }, TH);
  assert(out.some((s) => s.symptom === 'bad_cover_image'));
});

console.log('--- validation ---');
t('failures grouped by layer', () => {
  const out = _analyzeValidation({ failures: [{ layer: 'lsi' }, { layer: 'lsi' }, { layer: 'heads' }] });
  assert.equal(out.filter((s) => s.symptom === 'validation_failed').length, 2);
});

console.log('--- top_failure_layer ---');
t('finds layer with largest gap', () => {
  const qs = { subscores: { eeat: 55, fact_check: 92, plagiarism: 75 } };
  // eeat gap = 70 - 55 = 15 (default floor 70)
  assert.equal(_findTopFailureLayer(qs, TH), 'eeat');
});
t('returns null when all good', () => {
  const qs = { subscores: { eeat: 90, fact_check: 92 } };
  assert.equal(_findTopFailureLayer(qs, TH), null);
});

console.log('--- analyzeFailures end-to-end ---');
t('combines multiple reports', () => {
  const out = analyzeFailures({
    qualityScore: { overall: 60, subscores: { eeat: 60, fact_check: 65 } },
    reports: {
      fact_check_report:  { verdict: 'review', unsupportedPctTotal: 50, score: 55 },
      plagiarism_report:  { verdict: 'review', overlapPctTotal: 40, score: 65 },
      readability_report: { passivePct: 30 },
      lsi_report:         { coverage: 0.3 },
      eeat_audit:         { subscores: { experience: 4, expertise: 7, authority: 7, trust: 7 } },
    },
  });
  assert(out.failure_reasons.includes('unsupported_numbers'));
  assert(out.failure_reasons.includes('paraphrase_too_close'));
  assert(out.failure_reasons.includes('too_passive'));
  assert(out.failure_reasons.includes('missing_lsi'));
  assert(out.failure_reasons.includes('lacks_personal_experience'));
  assert.equal(out.verdict_summary.fact_check, 'review');
  assert.equal(out.verdict_summary.plagiarism, 'review');
  assert.equal(out.top_failure_layer, 'eeat');
});
t('empty reports = empty diagnoses', () => {
  const out = analyzeFailures({ qualityScore: { overall: 95, subscores: { eeat: 95 } }, reports: {} });
  assert.deepEqual(out.failure_reasons, []);
  assert.equal(out.top_failure_layer, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
