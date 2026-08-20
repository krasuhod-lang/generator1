'use strict';

const assert = require('assert');
const { resolveQueueReason } = require('../src/services/tasks/queueDiagnostics');

assert.strictEqual(resolveQueueReason({
  status: 'queued', availableSlots: 5, bullJobState: 'waiting', pendingOutbox: 1,
}), 'waiting');
assert.strictEqual(resolveQueueReason({
  status: 'queued', availableSlots: 5, bullJobState: 'delayed', pendingOutbox: 1,
}), 'delayed');
assert.strictEqual(resolveQueueReason({
  status: 'queued', availableSlots: 0, bullJobState: 'missing', pendingOutbox: 0,
}), 'profile_limit');
assert.strictEqual(resolveQueueReason({
  status: 'queued', availableSlots: 5, bullJobState: 'missing', pendingOutbox: 1,
}), 'waiting_for_publisher');
assert.strictEqual(resolveQueueReason({
  status: 'queued', availableSlots: 5, bullJobState: 'unavailable', pendingOutbox: 1,
}), 'publisher_unavailable');
assert.strictEqual(resolveQueueReason({
  status: 'processing', availableSlots: 5, bullJobState: 'active', pendingOutbox: 0,
}), null);

console.log('queue diagnostics test passed');
