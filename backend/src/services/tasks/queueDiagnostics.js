'use strict';

/**
 * Resolves the reason for a queued generation task from durable DB/outbox and
 * BullMQ observations. The order is intentional: a live Bull job is already
 * published, even if the outbox transaction has not been marked published yet.
 */
function resolveQueueReason({
  status,
  availableSlots,
  bullJobState,
  pendingOutbox,
}) {
  if (status !== 'queued') return null;

  if (Number(availableSlots) === 0) return 'profile_limit';

  if (['waiting', 'delayed', 'active', 'paused'].includes(String(bullJobState || ''))) {
    return String(bullJobState);
  }

  if (bullJobState === 'missing' && Number(pendingOutbox) > 0) {
    return 'waiting_for_publisher';
  }

  if (bullJobState === 'unavailable' && Number(pendingOutbox) > 0) {
    return 'publisher_unavailable';
  }

  if (Number(pendingOutbox) > 0) return 'waiting_for_publisher';
  if (bullJobState === 'missing') return 'recovery_pending';
  return 'waiting_for_worker';
}

module.exports = { resolveQueueReason };
