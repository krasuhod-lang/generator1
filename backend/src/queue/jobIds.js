'use strict';

/**
 * BullMQ custom jobId cannot contain ':'. Keep IDs deterministic, readable and
 * safe for Redis keys. Existing legacy IDs are normalized by replacement.
 */
function normalizeBullJobId(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('BullMQ jobId cannot be empty');
  const normalized = raw
    .replace(/:/g, '-')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!normalized || normalized.startsWith('0-')) {
    return `job-${normalized || 'id'}`;
  }
  return normalized.slice(0, 240);
}

function makeBullJobId(prefix, ...parts) {
  return normalizeBullJobId([prefix, ...parts].filter((part) => part !== undefined && part !== null).join('-'));
}

module.exports = { normalizeBullJobId, makeBullJobId };
