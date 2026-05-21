/* eslint-disable no-console */
'use strict';

/**
 * test-quality-feedback.js — offline smoke-тест detection-логики
 * qualityFeedback и порогов modelSelector. БД-вызовы заменены ручными
 * фикстурами (тестируем чистые функции).
 */

const {
  percentile,
  mean,
  analyzeTaskFeedback,
  CONFIG,
} = require('../src/services/qualityLayers/qualityFeedback');

const { CONFIG: SELECTOR_CONFIG } = require('../src/services/llm/modelSelector');

let failed = 0, passed = 0;
function ok(name, cond, details) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
}

console.log('\n=== test-quality-feedback ===\n');

// ── percentile / mean ──────────────────────────────────────────────
ok('percentile([1..100], 25) ≈ 25',
   Math.abs(percentile([...Array(100)].map((_, i) => i + 1), 25) - 25) <= 1);
ok('percentile([], 50) = null', percentile([], 50) === null);
ok('mean([10,20,30]) = 20', mean([10, 20, 30]) === 20);
ok('mean([]) = null', mean([]) === null);

// ── analyzeTaskFeedback ────────────────────────────────────────────

// Малая выборка → insufficient_sample
{
  const r = analyzeTaskFeedback({
    taskQualityScore: { overall: 70 },
    history: [{ quality_score: { overall: 80 } }],
  });
  ok('small sample → insufficient_sample', r.reason === 'insufficient_sample');
  ok('small sample → needs_review=false',  r.needs_review === false);
}

// Низкий overall vs история → needs_review=true
{
  const history = [...Array(20)].map((_, i) => ({
    quality_score: {
      overall: 80 + i, // 80..99
      sub: { eeat: 80, readability: 75 },
    },
  }));
  const r = analyzeTaskFeedback({
    taskQualityScore: { overall: 40, sub: { eeat: 30, readability: 70 } },
    history,
  });
  ok('low overall < p25 → needs_review=true', r.needs_review === true);
  ok('reason = below_p25', r.reason === 'below_p25');
  ok('p25 is set', r.p25 !== null);
  ok('defects has eeat (delta ≥ 15)',
     r.defects.some((d) => d.submetric === 'eeat'));
  ok('defects does NOT include readability (delta < 15)',
     !r.defects.some((d) => d.submetric === 'readability'));
}

// Хороший overall → needs_review=false
{
  const history = [...Array(20)].map((_, i) => ({
    quality_score: { overall: 70 + (i % 10), sub: {} },
  }));
  const r = analyzeTaskFeedback({
    taskQualityScore: { overall: 85, sub: {} },
    history,
  });
  ok('high overall → needs_review=false', r.needs_review === false);
  ok('reason = ok', r.reason === 'ok');
  ok('defects = [] when not low', r.defects.length === 0);
}

// Нет overall → no_overall
{
  const r = analyzeTaskFeedback({
    taskQualityScore: { overall: null },
    history: [],
  });
  ok('no overall → reason = no_overall', r.reason === 'no_overall');
}

// ── modelSelector CONFIG sanity ────────────────────────────────────
ok('modelSelector default enabled=false', SELECTOR_CONFIG.enabled === false);
ok('modelSelector minSampleSize ≥ 1', SELECTOR_CONFIG.minSampleSize >= 1);
ok('modelSelector tieBreakDelta > 0', SELECTOR_CONFIG.tieBreakDelta > 0);
ok('qualityFeedback CONFIG frozen', Object.isFrozen(CONFIG));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
