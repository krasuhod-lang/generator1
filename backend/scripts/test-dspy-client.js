'use strict';

/**
 * Smoke-тест node-обёртки DSPy (п.6 ТЗ). Проверяет graceful-fallback при
 * недоступности aegis_py (AEGIS_PY_URL не задан). Без сети.
 * Запуск: node backend/scripts/test-dspy-client.js
 */

const assert = require('assert');

// Гарантируем, что aegis_py НЕ сконфигурирован для этого теста.
delete process.env.AEGIS_PY_URL;

const { enhancePrompt, buildPromptSuffix } = require('../src/services/projects/dspyClient');
const { getProjectsConfig } = require('../src/services/projects/config');

let passed = 0; let failed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${name}`); }
  catch (err) { failed += 1; console.error(`  ✗ ${name}\n    ${err.message}`); }
}

(async () => {
  const cfg = getProjectsConfig().dspy;

  await test('config exposes the 6 expected signatures', () => {
    ['LinkRecommend', 'BlogTopicSuggest', 'EatRecommend', 'GeoAeoBoost', 'MetaUplift', 'SchemaSuggest']
      .forEach((s) => assert.ok(cfg.signatures.includes(s), `missing ${s}`));
  });

  await test('enhancePrompt returns not_configured when AEGIS_PY_URL empty', async () => {
    const r = await enhancePrompt('LinkRecommend', { niche: 'plumbing' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'not_configured');
  });

  await test('enhancePrompt rejects unknown signature', async () => {
    const r = await enhancePrompt('NotASignature', {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, 'unknown_signature');
  });

  await test('buildPromptSuffix returns empty string when DSPy unavailable', async () => {
    const suffix = await buildPromptSuffix('BlogTopicSuggest', { count: 5 });
    assert.strictEqual(suffix, '');
  });

  console.log(`\nDSPy-client smoke test: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
