'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const callLLMPath = require.resolve(path.join(repoRoot, 'src/services/llm/callLLM.js'));
const deepseekPath = require.resolve(path.join(repoRoot, 'src/services/llm/deepseek.adapter.js'));
const autoClosePath = require.resolve(path.join(repoRoot, 'src/utils/autoCloseJSON.js'));
const callLLMReal = require(callLLMPath);
const autoClose = require(autoClosePath);

async function run() {
  const truncated = '{"mathematical_audit":{"lsi_coverage_percent":18,"spam_risk_detected":true},"pq_score":1,"actionable_next_steps":[{"problem":"x","solution":"y"';
  const repaired = JSON.parse(autoClose.autoCloseJSON(truncated));
  assert.strictEqual(repaired.pq_score, 1, 'autoCloseJSON must close a truncated audit object');
  assert.deepStrictEqual(repaired.actionable_next_steps, [{ problem: 'x', solution: 'y' }]);

  const nestedTrailing = '{"a":[1,2,],"b":{"c":true,},}';
  assert.deepStrictEqual(JSON.parse(autoClose.autoCloseJSON(nestedTrailing)), { a: [1, 2], b: { c: true } });

  const danglingEscape = '{"reason":"unfinished\\';
  assert.strictEqual(JSON.parse(autoClose.autoCloseJSON(danglingEscape)).reason, 'unfinished\\');

  const deepseekSource = fs.readFileSync(deepseekPath, 'utf8');
  assert(deepseekSource.includes('body.response_format = responseFormat'), 'DeepSeek adapter must forward JSON mode');
  assert(deepseekSource.includes('delete legacyBody.response_format'), 'DeepSeek adapter must have JSON mode fallback');

  const orchestratorSource = fs.readFileSync(path.join(repoRoot, 'src/services/pipeline/orchestrator.js'), 'utf8');
  assert(orchestratorSource.includes('activeAudits < 2'), 'audit concurrency must be capped at two blocks per task');
  assert(orchestratorSource.includes("type: 'budget_skip'"), 'orchestrator must publish budget_skip diagnostics');

  const originalCallModule = require.cache[callLLMPath];
  require.cache[callLLMPath] = {
    id: callLLMPath,
    filename: callLLMPath,
    loaded: true,
    exports: {
      ...callLLMReal,
      callLLM: async () => {
        const error = new Error('gemini token budget exhausted for task test: 199999/200000 input tokens reserved');
        error.isBudgetExceeded = true;
        error.isDeterministic = true;
        throw error;
      },
    },
  };

  const stage5Path = require.resolve(path.join(repoRoot, 'src/services/pipeline/stage5.js'));
  const stage6Path = require.resolve(path.join(repoRoot, 'src/services/pipeline/stage6.js'));
  delete require.cache[stage5Path];
  delete require.cache[stage6Path];

  try {
    const { runStage5 } = require(stage5Path);
    const { runStage6 } = require(stage6Path);
    const logs = [];
    const ctx = { taskId: 'test-task', log: (message) => logs.push(String(message)), onTokens: () => {} };
    const task = {
      input_target_service: 'тестовая услуга',
      input_brand_facts: 'подтверждённый факт',
      input_brand_name: 'Тестовый бренд',
      input_raw_lsi: '',
      input_tfidf_json: '[]',
    };
    const html = '<h2>Тест</h2><p>Короткий подтверждённый текст.</p>';
    const audit = { pq_score: 1, mathematical_audit: { spam_risk_detected: false } };

    const [stage5, stage6] = await Promise.all([
      runStage5(task, ctx, 0, html, ['тестовая услуга'], audit, 1, [], 'Тест', false),
      runStage6(task, ctx, 0, html, ['отсутствующий термин']),
    ]);

    assert.strictEqual(stage5.html, html, 'Stage 5 must keep best HTML on budget skip');
    assert.strictEqual(stage5.budgetSkipped, true, 'Stage 5 must expose budgetSkipped');
    assert.strictEqual(stage6.html, html, 'Stage 6 must keep best HTML on budget skip');
    assert.strictEqual(stage6.budgetSkipped, true, 'Stage 6 must expose budgetSkipped');
    assert(logs.some((line) => line.includes('budget_skip')), 'budget_skip must be logged');
  } finally {
    if (originalCallModule) require.cache[callLLMPath] = originalCallModule;
    else delete require.cache[callLLMPath];
    delete require.cache[stage5Path];
    delete require.cache[stage6Path];
  }
}

run()
  .then(() => console.log('generation-error-recovery: 8/8 passed'))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });

module.exports = { run };
