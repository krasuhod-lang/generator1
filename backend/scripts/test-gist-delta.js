'use strict';

/**
 * test-gist-delta.js — unit-тесты Task B без сети/LLM.
 * Запуск: node backend/scripts/test-gist-delta.js
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// Подменяем metaTags/xmlstockClient до require(fetchGoogleSerp), чтобы не
// загружать реальный модуль с ключами/сетевыми настройками.
const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...args) {
  if (request === '../metaTags/xmlstockClient') {
    return { fetchGoogleSerp: async () => [] };
  }
  if (request === '../parser/scraper') {
    return { scrapeUrl: async () => ({ title: '', markdown: '' }) };
  }
  return originalLoad.call(this, request, ...args);
};

const {
  _isStoppedDomain,
  _countWords,
  _mapSerpItem,
  _googleOpts,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'fetchGoogleSerp'));
const {
  computeGistCoverageScore,
  normalizeGistAuditReport,
  buildGistRewriteIssues,
} = require(path.join(__dirname, '..', 'src', 'services', 'infoArticle', 'gistAudit'));

Module._load = originalLoad;

let cases = 0;
let passed = 0;
function check(name, fn) {
  cases += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ❌ ${name}\n     ${e && e.message ? e.message : e}`);
  }
}

console.log('\n=== Test 1: stop-domain filtering ===');
check('filters exact stop domain', () => {
  assert.strictEqual(_isStoppedDomain('https://youtube.com/watch?v=1'), true);
});
check('filters subdomain of stop domain', () => {
  assert.strictEqual(_isStoppedDomain('https://m.youtube.com/watch?v=1'), true);
});
check('allows normal competitor domain', () => {
  assert.strictEqual(_isStoppedDomain('https://example.ru/blog/a'), false);
});

console.log('\n=== Test 2: SERP mapping/options ===');
check('maps xmlstock title/snippet to serp fields', () => {
  assert.deepStrictEqual(
    _mapSerpItem({ url: 'https://a.ru', title: 'T', snippet: 'S' }),
    { url: 'https://a.ru', serp_title: 'T', serp_description: 'S' },
  );
});
check('google opts use google.ru for ru lang and enough pages', () => {
  assert.deepStrictEqual(_googleOpts({ region: 'ru', lang: 'ru', top_n: 11 }), {
    pages: 2,
    startPage: 0,
    lr: 'ru',
    domain: 'google.ru',
  });
});
check('word counter handles ru/en tokens', () => {
  assert.strictEqual(_countWords('Привет, мир! hello-world 2026'), 4);
});

console.log('\n=== Test 3: GIST coverage score ===');
check('yes=1 partial=0.5 no=0', () => {
  const score = computeGistCoverageScore([
    { coverage: 'yes' },
    { coverage: 'partial' },
    { coverage: 'no' },
    { coverage: 'yes' },
  ]);
  assert.strictEqual(score, 62.5);
});
check('empty delta is 100 (nothing to cover)', () => {
  assert.strictEqual(computeGistCoverageScore([]), 100);
});

console.log('\n=== Test 4: audit normalization/rewrite issues ===');
check('normalizes alternate fields and clamps score', () => {
  const report = normalizeGistAuditReport({
    information_delta_coverage: [{ claim: 'A', status: 'да' }],
    sections: [{ index: 2, title: 'H2', redundancy: 'высокая' }],
    gist_coverage_score: 140,
    needs_rewrite: [{ index: 2, title: 'H2', reason: 'too generic' }],
  }, ['A']);
  assert.strictEqual(report.gist_coverage_score, 100);
  assert.strictEqual(report.thesis_coverage[0].coverage, 'yes');
  assert.strictEqual(report.section_audit[0].gist_redundancy, 'high');
});
check('builds de-duplicated rewrite issues for high redundancy', () => {
  const issues = buildGistRewriteIssues({
    section_audit: [{ section_index: 1, h2: 'A', gist_redundancy: 'high' }],
    needs_rewrite: [{ section_index: 1, h2: 'A', reason: 'generic' }],
  });
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].category, 'gist_delta');
});

console.log('\n────────────────────────────────────────────────────────────');
if (passed === cases) {
  console.log(`✅ All ${cases} GIST delta tests passed`);
  process.exit(0);
}
console.log(`❌ ${passed}/${cases} passed`);
process.exit(1);
