'use strict';

const assert = require('node:assert/strict');
const db = require('../src/config/db');

const originalQuery = db.query;
const ledgerRows = [];
db.query = async (_sql, params) => {
  ledgerRows.push(params);
  return { rows: [] };
};

(async () => {
  try {
    const {
      normalizeTargetPageAnalysis,
      normalizeAudienceNicheAnalysis,
    } = require('../src/utils/analysisResultNormalizer');
    const {
      recordProviderResponse,
    } = require('../src/services/metrics/providerAttemptAccounting');

    const target = normalizeTargetPageAnalysis({
      target_audience: { text: 'Покупатели услуги' },
      niche_features: 'локальная ниша\nсезонный спрос',
      category_clients: { a: 'B2C', b: 'B2B' },
      works_with: 'частные лица; компании',
      brand_facts: 0,
    });
    assert.deepEqual(target.niche_features, ['локальная ниша', 'сезонный спрос']);
    assert.deepEqual(target.client_segments, ['B2C', 'B2B']);
    assert.deepEqual(target.works_with, ['частные лица', 'компании']);
    assert.equal(target.target_audience, null);
    assert.equal(target.data_completeness.status, 'partial');
    assert.ok(target.data_completeness.missing_fields.includes('eeat_signals_present'));

    const audience = normalizeAudienceNicheAnalysis({
      audience_personas: 'not-an-array',
      niche_terminology: 'термин 1; термин 2',
      content_voice: 'not-an-object',
    });
    assert.deepEqual(audience.niche_terminology, ['термин 1', 'термин 2']);
    assert.equal(audience.data_completeness.status, 'partial');
    assert.ok(audience.data_completeness.missing_fields.includes('audience_personas'));

    const callbackEvents = [];
    await recordProviderResponse({
      provider: 'deepseek',
      result: {
        model: 'deepseek-v4-pro',
        tokensIn: 1200,
        tokensOut: 340,
        cacheHitTokens: 100,
        cacheMissTokens: 1100,
        cost: 0.0042,
        finishReason: 'length',
      },
      taskId: '00000000-0000-4000-8000-000000000001',
      traceTaskId: '00000000-0000-4000-8000-000000000001',
      pipeline: 'test',
      stageName: 'direct_mock',
      callLabel: 'direct mock response',
      onAttemptUsage: (...args) => callbackEvents.push(args),
      meta: { parse_status: 'pending' },
    });
    assert.equal(callbackEvents.length, 1);
    assert.equal(callbackEvents[0][0], 'deepseek');
    assert.equal(callbackEvents[0][1], 1200);
    assert.equal(callbackEvents[0][2], 340);
    assert.equal(ledgerRows.length, 1);
    assert.equal(ledgerRows[0][0], 'deepseek');
    assert.equal(ledgerRows[0][5], '00000000-0000-4000-8000-000000000001');
    assert.equal(ledgerRows[0][7], 'provider_response');
    const ledgerMeta = JSON.parse(ledgerRows[0][23]);
    assert.equal(ledgerMeta.pricing_known, true);
    assert.equal(ledgerMeta.parse_status, 'pending');

    console.log('EVIDENCE_ACCOUNTING_NORMALIZER_OK');
  } finally {
    db.query = originalQuery;
  }
})().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exitCode = 1;
});
