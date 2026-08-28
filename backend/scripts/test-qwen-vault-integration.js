'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'layout-test-only-secret';
process.env.DASHSCOPE_API_KEY = 'env-qwen-test-secret';

const vault = require('../src/services/integrations/integrationVault');
const qwen = require('../src/services/llm/qwenAgent.adapter');

function fakeDb({ secretRow = null } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT encrypted_value/i.test(sql)) return { rows: secretRow ? [secretRow] : [] };
      if (/SELECT env_name, is_enabled/i.test(sql)) return { rows: [] };
      return { rows: [], rowCount: 1 };
    },
  };
}

(async () => {
  const envDb = fakeDb();
  const info = await vault.getIntegrationSecretInfo('DASHSCOPE_API_KEY', { db: envDb });
  assert.equal(info.value, 'env-qwen-test-secret');
  assert.equal(info.source, 'env');
  assert.equal(info.configured, true);
  const listed = await vault.listIntegrationSecrets({ db: envDb });
  const listedQwen = listed.find((item) => item.envName === 'DASHSCOPE_API_KEY');
  assert.equal(listedQwen.configured, true);
  assert.equal(listedQwen.source, 'env');

  const encrypted = vault.normalizeName('DASHSCOPE_API_KEY');
  assert.equal(encrypted, 'DASHSCOPE_API_KEY');
  assert.equal(vault.normalizeName('KEYSSO_API_KEY'), 'KEYS_SO_API_KEY');
  assert.match(vault.maskSecret('qwen-secret-1234'), /1234$/);
  assert.doesNotMatch(vault.maskSecret('qwen-secret-1234'), /qwen-secret/);

  const qwenJson = qwen.parseJsonObject('```json\n{"sources":[],"current_stats":[]}\n```');
  assert.deepEqual(qwenJson, { sources: [], current_stats: [] });
  const normalized = qwen.normalizeResearch({ current_stats: [1, 2], sources: [3] });
  assert.equal(normalized.current_stats.length, 2);
  assert.equal(normalized.sources.length, 1);
  assert.match(qwen.buildPrompt({ task: { input_target_service: 'тестовая тема' } }), /тестовая тема/);

  const root = path.resolve(__dirname, '..');
  const stage0 = fs.readFileSync(path.join(root, 'src/services/pipeline/stage0.js'), 'utf8');
  const adapter = fs.readFileSync(path.join(root, 'src/services/llm/qwenAgent.adapter.js'), 'utf8');
  const vaultService = fs.readFileSync(path.join(root, 'src/services/integrations/integrationVault.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/admin.routes.js'), 'utf8');
  const page = fs.readFileSync(path.join(root, '../frontend/src/views/admin/AdminApiKeysPage.vue'), 'utf8');

  assert.match(stage0, /runQwenResearchAgent/);
  assert.match(stage0, /fallback на DeepSeek\/Gemini/);
  assert.match(adapter, /qwen3\.8-max/);
  assert.match(adapter, /web_search/);
  assert.match(adapter, /web_extractor/);
  assert.match(adapter, /max_output_tokens/);
  assert.match(vaultService, /encryptToken/);
  assert.match(vaultService, /admin_integration_secrets/);
  assert.match(vaultService, /masked/);
  assert.match(routes, /\/api-keys/);
  assert.match(page, /API ключи и интеграции/);
  assert.match(page, /type="password"/);

  console.log('Qwen/vault integration regression: 19/19 checks passed');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
