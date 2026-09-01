'use strict';

const assert = require('assert');
const { runQwenResearchAgent } = require('../src/services/llm/qwenAgent.adapter');

(async () => {
  const previousTimeout = process.env.QWEN_RESEARCH_TIMEOUT_MS;
  process.env.QWEN_RESEARCH_TIMEOUT_MS = '600000';
  const records = [];
  const requests = [];
  const requestFn = async (_url, _body, options) => {
    requests.push(options);
    const error = new Error('timeout from deterministic test');
    error.code = 'ECONNABORTED';
    error.response = { status: 503, data: { message: 'temporary unavailable' } };
    throw error;
  };
  const recordFn = async (event) => {
    records.push(event);
    return true;
  };
  const task = {
    input_target_service: 'Тестовая услуга',
    input_region: 'Москва',
    input_language: 'ru',
  };

  try {
    await assert.rejects(
      runQwenResearchAgent({
        task,
        apiKeyOverride: 'test-key',
        requestFn,
        recordFn,
      }),
      /Qwen research API error 503/,
    );
    assert.strictEqual(requests.length, 1, 'first call must issue one request');
    assert.strictEqual(requests[0].timeout, 90_000, 'timeout must be capped at 90 seconds');
    assert.strictEqual(records[0].requestStatus, 'error');

    await assert.rejects(
      runQwenResearchAgent({
        task,
        apiKeyOverride: 'test-key',
        requestFn,
        recordFn,
      }),
      /circuit breaker is open/,
    );
    assert.strictEqual(requests.length, 1, 'open circuit must prevent another request');
    assert.ok(records.some((event) => event.requestStatus === 'circuit_open'));
  } finally {
    if (previousTimeout === undefined) delete process.env.QWEN_RESEARCH_TIMEOUT_MS;
    else process.env.QWEN_RESEARCH_TIMEOUT_MS = previousTimeout;
  }

  console.log('qwen circuit breaker contract: OK');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
