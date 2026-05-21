/* eslint-disable no-console */
'use strict';

/**
 * test-gemini-model-routing.js — оффлайн-проверка, что:
 *   1) normalizeGeminiCopywritingModel корректно разрешает алиасы;
 *   2) во всех ключевых местах пайплайна выбранная модель доходит до
 *      callGemini / callLLM через options.model;
 *   3) хардкод 'gemini-3.1-pro-preview' заменён на DEFAULT_GEMINI_COPYWRITING_MODEL.
 *
 * Никаких сетевых вызовов.
 */

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const {
  GEMINI_COPYWRITING_MODELS,
  DEFAULT_GEMINI_COPYWRITING_MODEL,
  normalizeGeminiCopywritingModel,
} = require('../src/services/llm/geminiModels');

let failed = 0;
let passed = 0;
function ok(name, cond, details) {
  if (cond) { passed += 1; console.log(`  ✅ ${name}`); }
  else      { failed += 1; console.log(`  ❌ ${name}${details ? ` — ${details}` : ''}`); }
}

console.log('\n=== test-gemini-model-routing ===\n');

// ── 1. normalizeGeminiCopywritingModel ────────────────────────────────
ok('default is gemini-3.1-pro-preview',
   DEFAULT_GEMINI_COPYWRITING_MODEL === 'gemini-3.1-pro-preview');

ok('two models registered', GEMINI_COPYWRITING_MODELS.length === 2);

ok('valid 3.1-pro-preview passes through',
   normalizeGeminiCopywritingModel('gemini-3.1-pro-preview') === 'gemini-3.1-pro-preview');
ok('valid 3.5-flash passes through',
   normalizeGeminiCopywritingModel('gemini-3.5-flash') === 'gemini-3.5-flash');

ok('alias 3.1-pro-preview → gemini-3.1-pro-preview',
   normalizeGeminiCopywritingModel('3.1-pro-preview') === 'gemini-3.1-pro-preview');
ok('alias 3.5-flash → gemini-3.5-flash',
   normalizeGeminiCopywritingModel('3.5-flash') === 'gemini-3.5-flash');

ok('case-insensitive (GEMINI-3.5-FLASH)',
   normalizeGeminiCopywritingModel('GEMINI-3.5-FLASH') === 'gemini-3.5-flash');

ok('unknown model → default',
   normalizeGeminiCopywritingModel('gemini-99-ultra') === DEFAULT_GEMINI_COPYWRITING_MODEL);
ok('empty → default',
   normalizeGeminiCopywritingModel('') === DEFAULT_GEMINI_COPYWRITING_MODEL);
ok('null → default',
   normalizeGeminiCopywritingModel(null) === DEFAULT_GEMINI_COPYWRITING_MODEL);
ok('undefined → default',
   normalizeGeminiCopywritingModel(undefined) === DEFAULT_GEMINI_COPYWRITING_MODEL);

ok('custom fallback respected if valid',
   normalizeGeminiCopywritingModel(null, 'gemini-3.5-flash') === 'gemini-3.5-flash');
ok('invalid fallback rolls back to default',
   normalizeGeminiCopywritingModel(null, 'invalid-x') === DEFAULT_GEMINI_COPYWRITING_MODEL);

// ── 2. Проверка отсутствия хардкода в пайплайн-файлах ────────────────
const filesToCheck = [
  'src/services/infoArticle/infoArticlePipeline.js',
  'src/services/linkArticle/linkArticlePipeline.js',
  'src/services/editorCopilot/streamRunner.js',
];
const repoRoot = path.resolve(__dirname, '..');
for (const rel of filesToCheck) {
  const full = path.join(repoRoot, rel);
  const src  = fs.readFileSync(full, 'utf8');
  // Грубо: ищем хардкоженный строковый литерал модели в default-цепочке.
  // Разрешено иметь литерал внутри импортов / комментариев — поэтому
  // проверяем именно паттерн `|| 'gemini-3.1-pro-preview'`.
  ok(
    `${rel} not hardcodes default model in || chain`,
    !/\|\|\s*['"]gemini-3\.1-pro-preview['"]/.test(src),
    'pipeline must use DEFAULT_GEMINI_COPYWRITING_MODEL constant'
  );
  // А константу импортирует.
  ok(
    `${rel} imports DEFAULT_GEMINI_COPYWRITING_MODEL`,
    /DEFAULT_GEMINI_COPYWRITING_MODEL/.test(src),
  );
}

// ── 3. Проверка, что normalize применяется в ключевых точках ─────────
const wireSites = [
  ['src/services/infoArticle/infoArticlePipeline.js', /model:\s*normalizeGeminiCopywritingModel\(task\.gemini_model\)/],
  ['src/services/linkArticle/linkArticlePipeline.js', /model:\s*normalizeGeminiCopywritingModel\(task\.gemini_model\)/],
  ['src/services/metaTags/metaGenerator.js',          /normalizeGeminiCopywritingModel\(inputs && inputs\.gemini_model\)/],
  ['src/services/articleTopics/articleTopicsPipeline.js', /normalizeGeminiCopywritingModel\(task\.gemini_model\)/],
  ['src/services/pipeline/orchestrator.js',           /normalizeGeminiCopywritingModel\(task\.gemini_model\)/],
];
for (const [rel, re] of wireSites) {
  const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
  ok(`${rel} wires normalize(task.gemini_model) into callOptions`, re.test(src));
}

// ── 4. Проверка, что callLLM логирует модель ─────────────────────────
{
  const src = fs.readFileSync(path.join(repoRoot, 'src/services/llm/callLLM.js'), 'utf8');
  ok('callLLM.js includes modelTag in success log',
     /modelTag\s*=\s*result\.model\s*\?/.test(src));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
