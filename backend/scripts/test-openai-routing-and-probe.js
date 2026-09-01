'use strict';

const assert = require('assert');
const fs = require('fs');
const {
  normalizeProvider,
  normalizeModel,
  resolveTaskModel,
  modelChoices,
} = require('../src/services/llm/modelRouting');
const { calculateCostBreakdown } = require('../src/services/metrics/priceCalculator');
const { _internals: probeInternals } = require('../src/services/integrations/integrationKeyProbe');
const { _internals: openaiInternals } = require('../src/services/llm/openai.adapter');
const { sanitizeTaskForClient } = require('../src/services/access/entitlementPolicy');

assert.strictEqual(normalizeProvider('openai'), 'openai');
assert.strictEqual(normalizeModel('openai', 'gpt-5.5'), 'gpt-5.5');
assert.strictEqual(normalizeModel('openai', 'not-a-gpt-model'), 'gpt-5');
assert.strictEqual(normalizeModel('grok', 'gemini-3.1-pro-preview'), null);
assert.deepStrictEqual(resolveTaskModel({ llm_provider: 'openai', llm_model: 'gpt-5-mini' }), {
  provider: 'openai',
  model: 'gpt-5-mini',
});
assert(modelChoices().openai.includes('gpt-5.5'));

const cost = calculateCostBreakdown('gpt-5', 1000, 2000, {
  cachedTokens: 100,
  reasoningTokens: 300,
});
assert.strictEqual(cost.provider, 'openai');
assert.strictEqual(cost.pricingKnown, true);
assert.strictEqual(cost.inputTokens, 1000);
assert.strictEqual(cost.outputTokens, 2000);
assert.strictEqual(cost.totalUsd, 0.02125);
assert.strictEqual(cost.pricingSource, 'live_model_catalog_snapshot');
assert(calculateCostBreakdown('gpt-5.5-2026-01-01', 1000, 1000).pricingKnown);

assert.strictEqual(openaiInternals._isGpt5Model('gpt-5.5'), true);
assert.strictEqual(openaiInternals._isGpt5Model('gemini-3.1-pro-preview'), false);
assert.strictEqual(openaiInternals._extractText({ content: [{ type: 'output_text', text: 'ok' }] }), 'ok');

const openaiEndpoint = probeInternals.endpointFor('OPENAI_API_KEY');
assert.strictEqual(openaiEndpoint.auth, 'bearer');
assert(openaiEndpoint.url.endsWith('/models'));
assert.deepStrictEqual(probeInternals.safeFailure({ response: { status: 401 } }), {
  status: 'inactive',
  active: false,
  message: 'Ключ отклонён провайдером',
});
assert.strictEqual(probeInternals.safeFailure({ code: 'ECONNABORTED' }).status, 'timeout');
const clientSafe = sanitizeTaskForClient({
  id: 'task',
  llm_provider: 'openai',
  llm_model: 'gpt-5',
  openai_tokens_in: 100,
  openai_tokens_out: 50,
  openai_cost_usd: 0.001,
  full_html: '<p>ready</p>',
  quality_score: { model_used: 'gpt-5', openai_cost_usd: 0.002, overall: 8 },
});
assert.strictEqual(clientSafe.llm_provider, undefined);
assert.strictEqual(clientSafe.openai_tokens_in, undefined);
assert.strictEqual(clientSafe.openai_cost_usd, undefined);
assert.strictEqual(clientSafe.full_html, '<p>ready</p>');
assert.strictEqual(clientSafe.quality_score.model_used, undefined);
assert.strictEqual(clientSafe.quality_score.openai_cost_usd, undefined);
assert.strictEqual(clientSafe.quality_score.overall, 8);
const adminStoreSource = fs.readFileSync(require.resolve('../../frontend/src/stores/admin.js'), 'utf8');
assert(adminStoreSource.includes('probeIntegrationKey,') && adminStoreSource.includes('probeAllIntegrationKeys,'));
const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');
assert(serverSource.includes("CHECK (llm_provider IN ('gemini', 'grok', 'openai'))"));
assert(serverSource.includes('ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS openai_tokens_in'));
assert(serverSource.includes('ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS openai_tokens_in'));
assert(serverSource.includes('ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS openai_tokens_in'));
assert(serverSource.includes('ALTER TABLE task_metrics ALTER COLUMN total_cost_usd TYPE NUMERIC(18,12)'));

console.log('OPENAI_ROUTING_PROBE_OK');
