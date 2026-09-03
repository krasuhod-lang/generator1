'use strict';

const assert = require('assert');
const axios = require('axios');
const {
  callManus,
  _internals: {
    apiHeaders,
    buildTaskContent,
    extractTaskId,
    extractStatus,
    extractAssistantText,
    extractStructuredOutput,
  },
} = require('../src/services/llm/manus.adapter');

assert.strictEqual(apiHeaders('secret')['x-manus-api-key'], 'secret');
assert.strictEqual(buildTaskContent('SYS', 'PROMPT', { type: 'json_object' }).includes('Return only one valid JSON object'), true);
assert.strictEqual(extractTaskId({ ok: true, task_id: 'task_123' }), 'task_123');
assert.strictEqual(extractStatus({ data: [{ type: 'status_update', status: 'stopped' }] }), 'stopped');
assert.strictEqual(extractAssistantText({ data: [{ type: 'assistant_message', content: [{ type: 'text', text: '{"ok":true}' }] }] }), '{"ok":true}');
assert.deepStrictEqual(extractStructuredOutput({ data: [{ type: 'structured_output_result', structured_output_result: { success: true, value: { ok: true } } }] }), { ok: true });

async function main() {
  const originalPost = axios.post;
  const originalGet = axios.get;
  let createdBody;
  let pollCount = 0;
  process.env.MANUS_API_KEY = 'manus-contract-key';
  axios.post = async (url, body, config) => {
    createdBody = { url, body, config };
    return { status: 200, data: { ok: true, request_id: 'req_1', task_id: 'task_1' } };
  };
  axios.get = async (url, config) => {
    pollCount += 1;
    assert.strictEqual(url, 'https://api.manus.ai/v2/task.listMessages');
    assert.strictEqual(config.params.task_id, 'task_1');
    return pollCount === 1
      ? { status: 200, data: { data: [{ type: 'status_update', status: 'running' }] } }
      : { status: 200, data: { data: [
        { type: 'status_update', status: 'stopped' },
        { type: 'structured_output_result', structured_output_result: { success: true, value: { answer: 'ok' } } },
      ] } };
  };
  try {
    const result = await callManus('system', 'prompt', { responseFormat: { type: 'json_object' }, timeoutMs: 10_000 });
    assert.deepStrictEqual(JSON.parse(result.text), { answer: 'ok' });
    assert.strictEqual(result.manusTaskId, 'task_1');
    assert.strictEqual(result.requestId, 'req_1');
    assert.strictEqual(result.tokensIn, 0);
    assert.strictEqual(createdBody.body.message.content.includes('SYSTEM INSTRUCTIONS'), true);
    assert.strictEqual(createdBody.body.message.connectors, undefined);
    assert.strictEqual(createdBody.body.interactive_mode, false);
    assert.strictEqual(createdBody.body.hide_in_task_list, true);
    console.log('MANUS_ADAPTER_CONTRACT_OK checks=16');
  } finally {
    axios.post = originalPost;
    axios.get = originalGet;
    delete process.env.MANUS_API_KEY;
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
