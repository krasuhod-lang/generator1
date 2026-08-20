'use strict';

const assert = require('assert');
const { normalizeBullJobId, makeBullJobId } = require('../src/queue/jobIds');

for (const id of [
  'generation:task-1:start:123',
  'parser:task-1:item-2:retry:3',
  'site-crawl:task-3:reconcile',
  '0:legacy-job',
]) {
  const safe = normalizeBullJobId(id);
  assert(!safe.includes(':'), `unsafe jobId: ${safe}`);
  assert(safe.length <= 240, `jobId too long: ${safe.length}`);
}

assert.strictEqual(
  makeBullJobId('generation', 'task-1', 'start', 123),
  'generation-task-1-start-123',
);
assert.strictEqual(
  makeBullJobId('parser', 'task-1', 'item-2', 'retry', 3),
  'parser-task-1-item-2-retry-3',
);

console.log('bull job id test passed');
