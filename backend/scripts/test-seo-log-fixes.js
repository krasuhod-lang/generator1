'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const { getBudgetInputTokens } = require(path.join(repoRoot, 'backend', 'src', 'services', 'llm', 'callLLM'));
const { compactKnowledgeBaseForCalls } = require(path.join(repoRoot, 'backend', 'src', 'utils', 'articleKnowledgeBase'));

let cases = 0;
let passed = 0;
function check(name, fn) {
  cases += 1;
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.log(`  ✗ ${name}: ${error.message}`);
  }
}

check('cached Gemini input is excluded only from guard accounting', () => {
  assert.strictEqual(getBudgetInputTokens('gemini', { tokensIn: 10000, cachedTokens: 8000 }), 2000);
  assert.strictEqual(getBudgetInputTokens('deepseek', { tokensIn: 10000, cachedTokens: 8000 }), 10000);
});

check('partial or invalid cache usage never creates negative budget tokens', () => {
  assert.strictEqual(getBudgetInputTokens('gemini', { tokensIn: 1000, cachedTokens: 5000 }), 0);
  assert.strictEqual(getBudgetInputTokens('gemini', { tokensIn: 1000, cachedTokens: -10 }), 1000);
  assert.strictEqual(getBudgetInputTokens('gemini', { tokensIn: 0, cachedTokens: 10 }), 0);
});

check('call-time AKB is bounded without dropping high-value sections', () => {
  const nl = String.fromCharCode(10);
  const giant = [
    '# ARTICLE KNOWLEDGE BASE',
    `## 0.8 E-E-A-T 12 / EVIDENCE-FIRST CONTRACT${nl}${'evidence '.repeat(1800)}`,
    `## 1. Brand & Offer${nl}Бренд: Тест${nl}${'facts '.repeat(1800)}`,
    `## 6. SERP Reality & Gaps${nl}${'serp '.repeat(1800)}`,
    `## 10. Hard Constraints${nl}Не выдумывать факты${nl}${'rules '.repeat(1800)}`,
    `## 4. Niche Deep Dive${nl}${'niche '.repeat(1800)}`,
  ].join(`${nl}${nl}`);
  const bounded = compactKnowledgeBaseForCalls(giant);
  assert(bounded.length <= 26000);
  assert(bounded.includes('E-E-A-T 12'));
  assert(bounded.includes('Brand & Offer'));
  assert(bounded.includes('Hard Constraints'));
});

const sourceAssertions = [
  ['backend/src/services/pipeline/stage0.js', ['formatCompetitorEvidence', 'buildEvidenceItems', 'STAGE0_GIST_PAGE_CHARS', 'STAGE0_SERP_TOTAL_CHARS', 'STAGE0_GIST_TOTAL_CHARS', "stage_status: 'skipped'", "skip_reason: 'no_competitor_urls'"]],
  ['backend/src/services/llm/callLLM.js', ['persistTaskAttemptMetrics', 'qwen_tokens_in', 'requestStatus: \'truncated\'', 'safeRecordApiRequest']],
  ['backend/src/services/llm/qwenAgent.adapter.js', ['persistQwenTaskMetrics', "provider: 'qwen'", 'not_reported_by_provider']],
  ['backend/src/services/llm/pipelineTrace.js', ['traceTableUnavailable', 'optional table pipeline_traces is unavailable']],
  ['backend/src/controllers/admin.controller.js', ['by_task', "meta->>'pricing_known'"]],
  ['backend/src/services/metrics/apiObservabilitySchema.js', ['ix_admin_api_ledger_task_ref', 'CREATE TABLE IF NOT EXISTS pipeline_traces']],
  ['backend/src/services/tasks/durableSchema.js', ['qwen_tokens_in', 'qwen_cost_usd']],
  ['migrations/153_qwen_usage_metrics.sql', ['ALTER TABLE task_metrics', 'qwen_tokens_in', 'qwen_cost_usd']],
  ['migrations/151_api_ledger_task_indexes.sql', ['COALESCE(task_id, trace_task_id)', 'CREATE TABLE IF NOT EXISTS pipeline_traces']],
  ['backend/src/services/pipeline/stage3.js', ['compactWriterJson', 'WRITER_CONTEXT_MAX_CHARS']],
  ['backend/src/services/pipeline/stage4.js', ['HTML_CONTENT_TRUNCATED_FOR_AUDIT', 'retryOnTruncation: true']],
  ['backend/src/services/pipeline/stage7.js', ['FINAL_HTML_TRUNCATED_FOR_AUDIT', 'retryOnTruncation: true']],
  ['backend/src/services/gist/gistClient.js', ['GIST_TOTAL_CHARS', '_isTransientGistError', 'degraded']],
  ['backend/src/utils/fillPromptVars.js', ['PROMPT_FIELD_MAX_CHARS', 'compactPromptValue']],
];
for (const [relative, needles] of sourceAssertions) {
  check(`${relative} contains bounded log fix`, () => {
    const source = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    for (const needle of needles) assert(source.includes(needle), `${relative} missing ${needle}`);
  });
}

check('Stage 0 declarations precede context interpolation', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'backend/src/services/pipeline/stage0.js'), 'utf8');
  assert(source.indexOf('const serpEvidence') < source.indexOf('const serpRealityContext'));
  assert(source.indexOf('const researchEvidence') < source.indexOf('const researchContext'));
});

if (passed !== cases) {
  console.error(`✗ ${passed}/${cases} SEO log fix checks passed`);
  process.exit(1);
}
console.log(`✅ test-seo-log-fixes: all ${cases} checks passed`);
