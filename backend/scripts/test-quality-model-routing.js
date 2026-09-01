'use strict';

const assert = require('assert');
const {
  selectQualityRoute,
  callQualityModel,
  DEFAULT_OPENAI_MODELS,
} = require('../src/services/llm/qualityModelRouting');
const fs = require('fs');
const stage4Source = fs.readFileSync(require.resolve('../src/services/pipeline/stage4'), 'utf8');
const stage7Source = fs.readFileSync(require.resolve('../src/services/pipeline/stage7'), 'utf8');
const stage8Source = fs.readFileSync(require.resolve('../src/services/pipeline/stage8'), 'utf8');
const infoSource = fs.readFileSync(require.resolve('../src/services/infoArticle/infoArticlePipeline'), 'utf8');
const linkSource = fs.readFileSync(require.resolve('../src/services/linkArticle/linkArticlePipeline'), 'utf8');
const coreSource = fs.readFileSync(require.resolve('../src/services/eeatAudit/core'), 'utf8');

const openaiBlock = selectQualityRoute({ stage: 'block', openaiConfigured: true });
assert.deepStrictEqual(openaiBlock, {
  provider: 'openai',
  model: DEFAULT_OPENAI_MODELS.block,
  source: 'vault_openai',
});
assert.strictEqual(selectQualityRoute({ stage: 'global', openaiConfigured: true }).model, 'gpt-5.5');
assert.strictEqual(selectQualityRoute({ stage: 'block', openaiConfigured: false }).provider, 'deepseek');
assert.strictEqual(selectQualityRoute({ stage: 'block', openaiConfigured: false, providerOverride: 'openai' }).source, 'openai_unconfigured_fallback');
assert.strictEqual(selectQualityRoute({ stage: 'block', openaiConfigured: true, providerOverride: 'deepseek' }).source, 'forced_deepseek');

(async () => {
  const calls = [];
  const result = await callQualityModel({
    callLLM: async (provider, system, prompt, options) => {
      calls.push({ provider, model: options.model, label: options.callLabel });
      if (provider === 'openai') throw new Error('synthetic provider failure');
      return { ok: true };
    },
    route: openaiBlock,
    system: 'system',
    prompt: 'prompt',
    options: { retries: 1, callLabel: 'quality' },
    log: () => {},
  });
  assert.deepStrictEqual(result, { ok: true });
  assert.deepStrictEqual(calls.map((item) => item.provider), ['openai', 'deepseek']);
  assert.strictEqual(calls[0].model, 'gpt-5');
  assert.strictEqual(calls[1].model, 'deepseek-v4-pro');

  assert.match(stage4Source, /resolveQualityRoute\(\{ stage: 'block' \}\)/);
  assert.match(stage4Source, /callQualityModel\(\{/);
  assert.match(stage7Source, /resolveQualityRoute\(\{ stage: 'global' \}\)/);
  assert.match(stage7Source, /callQualityModel\(\{/);
  assert.match(stage8Source, /resolveQualityRoute\(\{ stage: 'stage8' \}\)/);
  assert.match(infoSource, /InfoArticle Stage 5 E-E-A-T route=/);
  assert.match(infoSource, /callModel: \(adapter, system, prompt, options\) => callQualityModel/);
  assert.match(linkSource, /LinkArticle Stage 5 E-E-A-T route=/);
  assert.match(linkSource, /callModel: \(adapter, system, prompt, options\) => callQualityModel/);
  assert.match(coreSource, /typeof options\.callModel === 'function'/);
  assert.match(coreSource, /callModel\(adapter, system, chunkUser/);

  console.log('QUALITY_MODEL_ROUTING_OK');
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
