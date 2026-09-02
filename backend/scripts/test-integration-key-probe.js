'use strict';

const assert = require('assert');
const {
  probeIntegrationKey,
  persistProbeResult,
  clearProbeResult,
  listProbeResults,
  _internals: { endpointFor, safeFailure },
} = require('../src/services/integrations/integrationKeyProbe');
const { listIntegrationSecrets } = require('../src/services/integrations/integrationVault');
const fs = require('fs');

const emptyVaultDb = {
  async query(sql) {
    assert.match(sql, /admin_integration_secrets/);
    return { rows: [] };
  },
};

async function main() {
  process.env.OPENAI_API_KEY = 'openai-probe-test-key';
  process.env.GEMINI_API_KEY = 'gemini-probe-test-key';
  process.env.RELEVANCE_INTERNAL_TOKEN = 'relevance-probe-test-token';
  process.env.SERPER_API_KEY = 'serper-probe-test-key';

  let openaiRequest;
  const openai = await probeIntegrationKey('OPENAI_API_KEY', {
    db: emptyVaultDb,
    request: async (config) => {
      openaiRequest = config;
      // Simulate a valid provider response larger than the old 1 KB cap.
      return { status: 200, data: 'x'.repeat(8_000) };
    },
  });
  assert.strictEqual(openai.status, 'active');
  assert.strictEqual(openai.active, true);
  assert.strictEqual(openai.httpStatus, 200);
  assert.strictEqual(openaiRequest.responseType, 'stream');
  assert.strictEqual(openaiRequest.headers.Authorization, 'Bearer openai-probe-test-key');
  assert(openaiRequest.url.endsWith('/models'));

  let geminiRequest;
  const gemini = await probeIntegrationKey('GEMINI_API_KEY', {
    db: emptyVaultDb,
    request: async (config) => {
      geminiRequest = config;
      return { status: 200, data: { models: [] } };
    },
  });
  assert.strictEqual(gemini.status, 'active');
  assert.strictEqual(geminiRequest.params.key, 'gemini-probe-test-key');
  assert(!geminiRequest.url.includes('probe'));
  assert(!geminiRequest.headers.Authorization);

  const rejected = await probeIntegrationKey('OPENAI_API_KEY', {
    db: emptyVaultDb,
    request: async () => ({ status: 401, data: { error: 'unauthorized' } }),
  });
  assert.strictEqual(rejected.status, 'inactive');
  assert.strictEqual(rejected.active, false);

  const rateLimited = await probeIntegrationKey('OPENAI_API_KEY', {
    db: emptyVaultDb,
    request: async () => ({ status: 429, data: { error: 'rate limit' } }),
  });
  assert.strictEqual(rateLimited.status, 'rate_limited');
  assert.strictEqual(rateLimited.active, null);

  let relevanceRequest;
  const relevance = await probeIntegrationKey('RELEVANCE_INTERNAL_TOKEN', {
    db: emptyVaultDb,
    request: async (config) => {
      relevanceRequest = config;
      return { status: 200, data: { ok: true } };
    },
  });
  assert.strictEqual(relevance.status, 'active');
  assert.strictEqual(relevanceRequest.headers['X-Internal-Token'], 'relevance-probe-test-token');
  assert(relevanceRequest.url.endsWith('/health'));

  let unsupportedCalled = false;
  const unsupported = await probeIntegrationKey('SERPER_API_KEY', {
    db: emptyVaultDb,
    request: async () => {
      unsupportedCalled = true;
      return { status: 200, data: {} };
    },
  });
  assert.strictEqual(unsupported.status, 'configured_unprobed');
  assert.strictEqual(unsupported.active, null);
  assert.strictEqual(unsupported.probeSupported, false);
  assert.strictEqual(unsupportedCalled, false);

  const registry = await listIntegrationSecrets({
    db: {
      async query(sql) {
        if (/admin_integration_secrets/.test(sql)) {
          return { rows: [{ env_name: 'OPENAI_API_KEY', is_enabled: false, last_rotated_at: null, updated_at: null }] };
        }
        return { rows: [] };
      },
    },
  });
  const openaiRegistry = registry.find((item) => item.envName === 'OPENAI_API_KEY');
  assert.strictEqual(openaiRegistry.configured, true);
  assert.strictEqual(openaiRegistry.source, 'env');
  assert.strictEqual(openaiRegistry.is_enabled, false);
  assert.strictEqual(openaiRegistry.masked, '••••••••-key');

  assert.strictEqual(endpointFor('RELEVANCE_INTERNAL_TOKEN').auth, 'internal_header');
  assert.strictEqual(safeFailure({ response: { status: 429 } }).status, 'rate_limited');

  const probeQueries = [];
  const probeDb = {
    async query(sql, params = []) {
      probeQueries.push({ sql, params });
      if (/SELECT env_name, status/.test(sql)) {
        return { rows: [{ env_name: 'OPENAI_API_KEY', status: 'active', active: true, probe_supported: true, http_status: 200, latency_ms: 12, message: 'ok', checked_at: '2026-09-02T10:00:00.000Z' }] };
      }
      return { rows: [] };
    },
  };
  await persistProbeResult({
    envName: 'OPENAI_API_KEY',
    status: 'active',
    active: true,
    probeSupported: true,
    httpStatus: 200,
    latencyMs: 12,
    message: 'ok',
    checkedAt: '2026-09-02T10:00:00.000Z',
    secretValue: 'must-not-be-stored',
  }, probeDb);
  const persistedSql = probeQueries.find((item) => /INSERT INTO admin_integration_key_probe_results/.test(item.sql));
  assert(persistedSql);
  assert(!persistedSql.sql.includes('secretValue'));
  assert(!persistedSql.params.includes('must-not-be-stored'));
  assert.deepStrictEqual((await listProbeResults(probeDb))[0].status, 'active');
  await clearProbeResult('OPENAI_API_KEY', probeDb);
  assert(probeQueries.some((item) => /DELETE FROM admin_integration_key_probe_results/.test(item.sql)));

  const migration = fs.readFileSync(require.resolve('../../migrations/154_integration_key_probe_results.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS admin_integration_key_probe_results/);
  assert.match(migration, /plaintext secret|response body/i);
  const controller = fs.readFileSync(require.resolve('../src/controllers/adminIntegrationKeys.controller.js'), 'utf8');
  const page = fs.readFileSync(require.resolve('../../frontend/src/views/admin/AdminApiKeysPage.vue'), 'utf8');
  assert.match(controller, /last_probe/);
  assert.match(controller, /listProbeResults/);
  assert.match(page, /item\.last_probe/);

  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.RELEVANCE_INTERNAL_TOKEN;
  delete process.env.SERPER_API_KEY;
  console.log('INTEGRATION_KEY_PROBE_OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
