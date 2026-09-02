'use strict';

const assert = require('assert');
const db = require('../src/config/db');
const { runQwenResearchAgent } = require('../src/services/llm/qwenAgent.adapter');

async function main() {
  const dbCalls = [];
  const ledgerCalls = [];
  const tokenEvents = [];
  const originalQuery = db.query;
  db.query = async (text, params) => {
    dbCalls.push({ text, params });
    return { rows: [] };
  };

  try {
    const result = await runQwenResearchAgent({
      task: {
        input_target_service: 'тестовая услуга',
        input_target_url: 'https://example.com',
        input_region: 'Россия',
        input_language: 'ru',
      },
      taskId: '00000000-0000-4000-8000-000000000001',
      apiKeyOverride: 'test-key',
      requestFn: async () => ({
        status: 200,
        data: {
          output_text: JSON.stringify({
            current_stats: [],
            expert_quotes: [],
            latest_trends: [],
            legal_or_price_updates: [],
            sources: [{
              url: 'https://example.com/source',
              title: 'Источник',
              source_type: 'official',
              accessed_at: '2026-09-02T00:00:00.000Z',
            }],
          }),
          usage: { input_tokens: 17, output_tokens: 9, total_tokens: 26 },
        },
      }),
      recordFn: async (payload) => { ledgerCalls.push(payload); },
      onTokens: (...args) => { tokenEvents.push(args); },
    });

    assert.strictEqual(result.provider, 'qwen');
    assert.strictEqual(result.usage.tokensIn, 17);
    assert.strictEqual(result.usage.tokensOut, 9);
    assert.strictEqual(result.usage.providerCostUsd, 0);
    assert.strictEqual(ledgerCalls.length, 1);
    assert.strictEqual(ledgerCalls[0].provider, 'qwen');
    assert.strictEqual(ledgerCalls[0].requestStatus, 'success');
    assert.strictEqual(ledgerCalls[0].costUsd, 0);
    assert.strictEqual(ledgerCalls[0].meta.billing, 'not_reported_by_provider');
    assert.strictEqual(tokenEvents.length, 1);
    assert.deepStrictEqual(tokenEvents[0].slice(0, 3), ['qwen', 17, 9]);
    assert.strictEqual(dbCalls.length, 1);
    assert(dbCalls[0].text.includes('qwen_tokens_in'));
    assert(dbCalls[0].text.includes('qwen_cost_usd'));
    assert(!dbCalls[0].text.includes('gemini_tokens_in'));

    console.log('qwen accounting mock: OK');
  } finally {
    db.query = originalQuery;
  }
}

main().catch((error) => {
  console.error(`qwen accounting mock: FAILED: ${error.message}`);
  process.exit(1);
});
