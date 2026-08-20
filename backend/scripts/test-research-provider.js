'use strict';

const assert = require('assert');
const {
  callResearchProvider,
  getResearchProviderOrder,
  hasResearchProvider,
} = require('../src/services/llm/researchProvider');

let passed = 0;
let failed = 0;

async function run(name, fn) {
  try {
    await fn();
    console.log('✓', name);
    passed += 1;
  } catch (error) {
    console.error('✗', name, '\n  ', error.message);
    failed += 1;
  }
}

(async () => {
  const saved = {
    primary: process.env.RESEARCH_PRIMARY_PROVIDER,
    fallback: process.env.RESEARCH_FALLBACK_PROVIDER,
    deepseek: process.env.DEEPSEEK_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
  };

  try {
    await run('provider order defaults to DeepSeek then Gemini', async () => {
      delete process.env.RESEARCH_PRIMARY_PROVIDER;
      delete process.env.RESEARCH_FALLBACK_PROVIDER;
      assert.deepStrictEqual(getResearchProviderOrder(), ['deepseek', 'gemini']);
    });

    await run('DeepSeek success does not call Gemini', async () => {
      process.env.RESEARCH_PRIMARY_PROVIDER = 'deepseek';
      process.env.RESEARCH_FALLBACK_PROVIDER = 'gemini';
      process.env.DEEPSEEK_API_KEY = 'test-deepseek';
      process.env.GEMINI_API_KEY = 'test-gemini';
      const calls = [];
      const result = await callResearchProvider({
        system: 'system',
        prompt: 'prompt',
        callFn: async (provider) => {
          calls.push(provider);
          return { provider, ok: true };
        },
      });
      assert.strictEqual(result.provider, 'deepseek');
      assert.deepStrictEqual(calls, ['deepseek']);
    });

    await run('DeepSeek failure falls back to Gemini', async () => {
      const calls = [];
      const result = await callResearchProvider({
        system: 'system',
        prompt: 'prompt',
        callFn: async (provider) => {
          calls.push(provider);
          if (provider === 'deepseek') throw new Error('test failure');
          return { provider, ok: true };
        },
      });
      assert.strictEqual(result.provider, 'gemini');
      assert.deepStrictEqual(calls, ['deepseek', 'gemini']);
    });

    await run('unconfigured providers are skipped without a call', async () => {
      delete process.env.DEEPSEEK_API_KEY;
      delete process.env.GEMINI_API_KEY;
      let called = false;
      const result = await callResearchProvider({
        system: 'system',
        prompt: 'prompt',
        callFn: async () => { called = true; return {}; },
      });
      assert.strictEqual(result, null);
      assert.strictEqual(called, false);
      assert.strictEqual(hasResearchProvider(), false);
    });
  } finally {
    if (saved.primary === undefined) delete process.env.RESEARCH_PRIMARY_PROVIDER;
    else process.env.RESEARCH_PRIMARY_PROVIDER = saved.primary;
    if (saved.fallback === undefined) delete process.env.RESEARCH_FALLBACK_PROVIDER;
    else process.env.RESEARCH_FALLBACK_PROVIDER = saved.fallback;
    if (saved.deepseek === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved.deepseek;
    if (saved.gemini === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved.gemini;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})();
