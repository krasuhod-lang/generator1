'use strict';

const assert = require('assert');
const {
  DEFAULT_MODEL,
  normalizeResponsesBaseUrl,
} = require('../src/services/llm/qwenAgent.adapter');

assert.strictEqual(DEFAULT_MODEL, 'qwen3.8-max');
assert.strictEqual(
  normalizeResponsesBaseUrl('https://dashscope-intl.aliyuncs.com/api/v1'),
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
);
assert.strictEqual(
  normalizeResponsesBaseUrl('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/'),
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
);
assert.strictEqual(
  normalizeResponsesBaseUrl('https://example.test/compatible-mode/v1/responses'),
  'https://example.test/compatible-mode/v1',
);
assert.strictEqual(
  normalizeResponsesBaseUrl('https://example.test/compatible-mode/v1/chat/completions'),
  'https://example.test/compatible-mode/v1',
);
assert.strictEqual(
  normalizeResponsesBaseUrl(''),
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
);

console.log('qwen responses endpoint contract: 6/6 checks passed');
