/* eslint-disable no-console */
'use strict';

/**
 * test-cache-flow.js — оффлайн-проверка корректности кэш-слоёв:
 *   1) iakbCallOpts/lakbCallOpts инкрементируют счётчик переиспользований
 *      при наличии task.__geminiCacheName и пробрасывают `cachedContent`
 *      в options;
 *   2) Очищают флаг при cache-miss (onCacheMiss callback);
 *   3) Не падают без cache-name;
 *   4) cachePolicy.shouldCache и normalizeBrand работают как ожидается.
 */

const path = require('path');

let failed = 0;
let passed = 0;
function ok(name, cond, details) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
}

console.log('\n=== test-cache-flow ===\n');

// ── 1. iakbCallOpts ──────────────────────────────────────────────────
{
  const { iakbCallOpts } = require('../src/services/infoArticle/infoArticleKnowledgeBase');

  // Без cache-name — opts должен быть пустым, счётчик не появляется
  {
    const task = { gemini_model: 'gemini-3.5-flash', brand_name: 'TestBrand' };
    const opts = iakbCallOpts(task, { temperature: 0.5 });
    ok('iakbCallOpts: model passed through',  opts.model === 'gemini-3.5-flash');
    ok('iakbCallOpts: temperature passed through', opts.temperature === 0.5);
    ok('iakbCallOpts: brand passed through',  opts.brand === 'TestBrand');
    ok('iakbCallOpts: no cachedContent when no cache name',
       opts.cachedContent === undefined);
    ok('iakbCallOpts: no reuse counter without cache name',
       !task.__geminiCacheReuseCount);
  }

  // С cache-name — opts.cachedContent выставлен, счётчик растёт.
  {
    const task = {
      gemini_model: 'gemini-3.1-pro-preview',
      __geminiCacheName: 'cachedContents/abc123',
      brand: 'LegacyBrand',
    };
    const o1 = iakbCallOpts(task);
    ok('iakbCallOpts: cachedContent wired',
       o1.cachedContent === 'cachedContents/abc123');
    ok('iakbCallOpts: counter = 1 after 1st use',
       task.__geminiCacheReuseCount === 1);
    iakbCallOpts(task);
    iakbCallOpts(task);
    ok('iakbCallOpts: counter = 3 after 3rd use',
       task.__geminiCacheReuseCount === 3);
    ok('iakbCallOpts: legacy brand wired',  o1.brand === 'LegacyBrand');
    ok('iakbCallOpts: onCacheMiss provided', typeof o1.onCacheMiss === 'function');
    // onCacheMiss обнуляет имя кэша на task
    o1.onCacheMiss();
    ok('iakbCallOpts: onCacheMiss clears __geminiCacheName',
       task.__geminiCacheName === null);
  }

  // brand_name приоритетнее legacy brand
  {
    const task = { brand_name: 'NewBrand', brand: 'OldBrand' };
    const opts = iakbCallOpts(task);
    ok('iakbCallOpts: brand_name beats legacy brand',
       opts.brand === 'NewBrand');
  }
}

// ── 2. lakbCallOpts ──────────────────────────────────────────────────
{
  const { lakbCallOpts } = require('../src/services/linkArticle/linkArticleKnowledgeBase');
  const task = {
    gemini_model: 'gemini-3.5-flash',
    __geminiCacheName: 'cachedContents/xyz',
  };
  const o1 = lakbCallOpts(task, { maxTokens: 12000 });
  ok('lakbCallOpts: maxTokens passed through', o1.maxTokens === 12000);
  ok('lakbCallOpts: cachedContent wired', o1.cachedContent === 'cachedContents/xyz');
  ok('lakbCallOpts: counter = 1', task.__geminiCacheReuseCount === 1);
  lakbCallOpts(task);
  ok('lakbCallOpts: counter = 2', task.__geminiCacheReuseCount === 2);
  o1.onCacheMiss();
  ok('lakbCallOpts: onCacheMiss clears name', task.__geminiCacheName === null);
}

// ── 3. cachePolicy.shouldCache / normalizeBrand ──────────────────────
{
  const cachePolicy = require('../src/services/llm/cachePolicy');
  ok('cachePolicy exports getCachePolicy',
     typeof cachePolicy.getCachePolicy === 'function');
  ok('cachePolicy exports normalizeBrand',
     typeof cachePolicy.normalizeBrand === 'function');
  ok('cachePolicy exports shouldCacheResponse',
     typeof cachePolicy.shouldCacheResponse === 'function');
  const p = cachePolicy.getCachePolicy();
  ok('cachePolicy: large prompts skipped',
     cachePolicy.shouldCacheResponse({
       adapter: 'deepseek',
       system: '',
       prompt: 'x'.repeat(p.maxKeyMaterialBytes + 1),
     }).reason === 'prompt_too_large');
}

// ── 4. orchestrator.js has stage→column map comment ──────────────────
{
  const fs = require('fs');
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/services/pipeline/orchestrator.js'),
    'utf8',
  );
  ok('orchestrator.js: header has «КАРТА КЭШИРОВАНИЯ»',
     /КАРТА КЭШИРОВАНИЯ/.test(src));
  ok('orchestrator.js: header lists stage0..stage8',
     /stage0_result/.test(src) && /stage8/.test(src));
  ok('orchestrator.js: header mentions quality_score',
     /quality_score/.test(src));
}

// ── 5. responseCache.js header has 3-layers map ─────────────────────
{
  const fs = require('fs');
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/services/llm/responseCache.js'),
    'utf8',
  );
  ok('responseCache.js: header documents 3 cache layers',
     /Gemini Context Caching/.test(src) && /Межстадийный/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
