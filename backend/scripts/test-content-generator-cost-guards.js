'use strict';

const assert = require('assert');

function check(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

const callLLMModule = require('../src/services/llm/callLLM');
const stage8 = require('../src/services/pipeline/stage8');
const { iakbCallOpts } = require('../src/services/infoArticle/infoArticleKnowledgeBase');
const { lakbCallOpts } = require('../src/services/linkArticle/linkArticleKnowledgeBase');

const originalBudget = process.env.GEMINI_TASK_TOKEN_BUDGET;

delete process.env.GEMINI_TASK_TOKEN_BUDGET;
check('GEMINI task budget has finite production default', () => {
  assert.strictEqual(callLLMModule.getConfiguredTaskTokenBudget(), 200000);
});

process.env.GEMINI_TASK_TOKEN_BUDGET = '123456';
check('GEMINI task budget accepts explicit positive override', () => {
  assert.strictEqual(callLLMModule.getConfiguredTaskTokenBudget(), 123456);
});

process.env.GEMINI_TASK_TOKEN_BUDGET = '0';
check('GEMINI task budget supports explicit opt-out', () => {
  assert.strictEqual(callLLMModule.getConfiguredTaskTokenBudget(), Infinity);
});

process.env.GEMINI_TASK_TOKEN_BUDGET = originalBudget;
const originalStage8 = process.env.STAGE8_EVALUATOR_ENABLED;

delete process.env.STAGE8_EVALUATOR_ENABLED;
check('Stage 8 evaluator is default-off', () => {
  assert.strictEqual(stage8.isStage8Enabled(), false);
});
process.env.STAGE8_EVALUATOR_ENABLED = 'true';
check('Stage 8 evaluator enables explicitly', () => {
  assert.strictEqual(stage8.isStage8Enabled(), true);
});
process.env.STAGE8_EVALUATOR_ENABLED = originalStage8;

const task = { gemini_model: 'gemini-3.1-pro-preview', __tokenBudget: 777 };
check('IAKB call opts propagate task token budget', () => {
  assert.strictEqual(iakbCallOpts(task).tokenBudget, 777);
});
check('LAKB call opts propagate task token budget', () => {
  assert.strictEqual(lakbCallOpts(task).tokenBudget, 777);
});

if (process.exitCode) process.exit(process.exitCode);
console.log('✅ test-content-generator-cost-guards: all checks passed');
