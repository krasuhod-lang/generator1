const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const callLLM = read('src/services/llm/callLLM.js');
const info = read('src/services/infoArticle/infoArticlePipeline.js');
const link = read('src/services/linkArticle/linkArticlePipeline.js');
const audience = read('src/services/infoArticle/audienceResearch.service.js');
const reddit = read('src/services/redditMapper/redditMapperPipeline.js');

assert(callLLM.includes('onAttemptUsage = null'), 'callLLM must expose onAttemptUsage');
const callbackIndex = callLLM.indexOf('if (onAttemptUsage)');
const persistIndex = callLLM.indexOf('await persistTaskAttemptMetrics({', callbackIndex);
const parseIndex = callLLM.indexOf('let parsed;', callbackIndex);
assert(callbackIndex >= 0 && persistIndex > callbackIndex && parseIndex > callbackIndex, 'attempt usage must be emitted before parse/acceptance');
assert(callLLM.includes('requestStatus: partialJson ? \'partial_json\' : (jsonRepaired ? \'repaired_json\' : \'success\')'), 'final ledger status must preserve repaired JSON');
assert(info.includes('onAttemptUsage: (adapter, tIn, tOut, cost, meta = {})'), 'blog context must forward attempt usage');
assert(link.includes('onAttemptUsage: (adapter, tIn, tOut, cost, meta = {})'), 'link context must forward attempt usage');
assert(audience.includes('onAttemptUsage: ctx && typeof ctx.onAttemptUsage === \'function\' ? ctx.onAttemptUsage : undefined'), 'audience bridge must forward attempt usage');
assert(reddit.includes('onAttemptUsage: opts.onAttemptUsage || null'), 'Reddit mapper must forward attempt usage');
assert(info.includes("publishEvent(taskId, 'tokens'"), 'blog realtime token events must remain available');
assert(link.includes("publishEvent(taskId, 'tokens'"), 'link realtime token events must remain available');
console.log('attempt usage reconciliation contract: OK');
