'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const adminController = read('src/controllers/admin.controller.js');
const adminCard = fs.readFileSync(path.resolve(root, '..', 'frontend/src/components/AdminApiUsageCard.vue'), 'utf8');
const schema = read('src/services/metrics/apiObservabilitySchema.js');
const metaFacade = read('src/services/metaTags/metaFacade.js');
const gistMetaFilter = read('src/services/metaTags/gistMetaFilter.js');
const orchestrator = read('src/services/pipeline/orchestrator.js');
const articleKnowledgeBase = read('src/utils/articleKnowledgeBase.js');
const stage3 = read('src/services/pipeline/stage3.js');
const stage4 = read('src/services/pipeline/stage4.js');
const stage5 = read('src/services/pipeline/stage5.js');
const stage6 = read('src/services/pipeline/stage6.js');
const stage7 = read('src/services/pipeline/stage7.js');
const preStage0 = read('src/services/pipeline/preStage0.js');
const callLLM = read('src/services/llm/callLLM.js');

const checks = [
  ['admin date range accepts YYYY-MM-DD', /\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$\//.test(adminController)],
  ['admin fallback includes explicit data quality state', /data_quality: \{ ledger_ready: false/.test(adminController)],
  ['admin response exposes historical task stage fallback', /historical_task_stages: \{/.test(adminController) && /approximate: true/.test(adminController)],
  ['existing ledger gets additive column self-heal', /ALTER TABLE admin_api_request_ledger/.test(schema) && /ADD COLUMN IF NOT EXISTS thoughts_tokens/.test(schema)],
  ['GIST meta usage writes to API ledger', /recordApiRequest/.test(metaFacade) && /billing_source: 'gist_meta_aggregate'/.test(metaFacade)],
  ['GIST task stage persists thoughts and split costs', /thoughts_tokens, input_cost_usd, output_cost_usd/.test(metaFacade)],
  ['GIST mixed provider cost is split by provider bucket', /function _recordUsage/.test(gistMetaFilter) && /providerUsage: buckets/.test(gistMetaFilter) && /_usageProviderBuckets/.test(metaFacade)],
  ['GIST preserves DeepSeek cache hit/miss split', /cacheHitTokens: cachedTokens/.test(gistMetaFilter) && /cacheMissTokens: Number\(bucket\.cacheMissTokens\)/.test(metaFacade)],
  ['API usage card shows legacy data instead of blank zeros', /historical_task_stages\?\.approximate/.test(adminCard) && /displayCost/.test(adminCard)],
  ['repair AKB is smaller than writer AKB', /__articleKnowledgeBaseForRepair/.test(orchestrator) && /compactKnowledgeBaseForCalls\(task\.__articleKnowledgeBase, 16000\)/.test(orchestrator) && /purpose === 'repair'/.test(articleKnowledgeBase)],
  ['audit concurrency is bounded at four', /SEO_AUDIT_CONCURRENCY/.test(orchestrator) && /Math\.min\(4, configuredAuditConcurrency\)/.test(orchestrator)],
  ['stage 3 writer truncation is bounded', /maxTokens: 20000/.test(stage3) && /maxTruncationTokens: 24000/.test(stage3) && /retries: 2/.test(stage3)],
  ['stage 4 audit retries have a bounded output cap', /maxTruncationTokens: 24000/.test(stage4) && /maxTokens: 12000/.test(stage4)],
  ['stage 2.5 uses DeepSeek V4 Pro', /model: 'deepseek-v4-pro'/.test(read('src/services/pipeline/stage2.js')) && !/SEO_SEMANTIC_MODEL|deepseek-v4-flash/.test(read('src/services/pipeline/stage2.js'))],
  ['stage 4 and stage 7 use DeepSeek V4 Pro', (stage4.match(/model: 'deepseek-v4-pro'/g) || []).length >= 2 && /model: 'deepseek-v4-pro'/.test(stage7) && !/SEO_AUDIT_MODEL|deepseek-v4-flash/.test(stage4 + stage7)],
  ['GIST analytics uses DeepSeek V4 Pro', /const analyticModel = 'deepseek-v4-pro'/.test(gistMetaFilter) && !/SEO_META_ANALYTIC_MODEL|deepseek-v4-flash/.test(gistMetaFilter)],
  ['stage 4 re-audit uses compact output mode', /RE-AUDIT COMPACT MODE/.test(stage4) && /maxTokens: 8000/.test(stage4)],
  ['stage 5 repair calls use bounded output and one retry-safe repair', /maxTokens: 12288/.test(stage5) && /maxTruncationTokens: 16384/.test(stage5) && /retries: 1/.test(stage5) && /repairOnJsonError: true/.test(stage5)],
  ['stage 6 LSI calls use bounded output and one retry-safe repair', /maxTokens: 12288/.test(stage6) && /maxTruncationTokens: 16384/.test(stage6) && /retries: 1/.test(stage6) && /repairOnJsonError: true/.test(stage6)],
  ['pre-stage strategic calls have bounded retries/tokens', /retries:\s+2/.test(preStage0) && /maxTokens:\s+10000/.test(preStage0) && /maxTruncationTokens:\s+14000/.test(preStage0)],
  ['callLLM preserves a configurable truncation cap', /maxTruncationTokens = 32000/.test(callLLM) && /retry cap/.test(callLLM)],
  ['stage 3 writer remains on default full AKB context', /akbSystem\(task\)/.test(stage3) && !/akbSystem\(task, \{ purpose: 'repair' \}\)/.test(stage3)],
];

let failures = 0;
for (const [name, passed] of checks) {
  try {
    assert.ok(passed, 'contract not found');
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    failures += 1;
  }
}

if (failures) {
  console.error(`❌ ${failures}/${checks.length} SEO runtime checks failed`);
  process.exit(1);
}
console.log(`✅ ALL OK (${checks.length}/${checks.length})`);
