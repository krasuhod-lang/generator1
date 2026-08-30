'use strict';

const assert = require('assert');
const {
  MAX_PROFILE_CONCURRENCY,
  claimGenerationTask,
  getProfileQueueHealth,
} = require('../src/services/tasks/generationAdmission');

function makeClient(activeCount = 0) {
  return {
    async query(sql) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/i.test(sql)) return { rows: [] };
      if (/SELECT u\.id[\s\S]*user_access_profiles/i.test(sql)) {
        return { rows: [{ id: 'profile-1', email: 'test@example.com', role: 'user', legacy_role: 'user', account_role: 'client', plan_key: 'trial', status: 'active', period_start: new Date('2026-01-01T00:00:00Z'), period_end: null, overrides: {} }] };
      }
      if (/SELECT id, user_id, status, lease_until/i.test(sql)) {
        return { rows: [{ id: 'task-1', user_id: 'profile-1', status: 'queued', lease_until: null }] };
      }
      if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [] };
      if (/SELECT COUNT\(\*\)::int AS count/i.test(sql)) return { rows: [{ count: activeCount }] };
      if (/UPDATE tasks/i.test(sql)) {
        return activeCount >= MAX_PROFILE_CONCURRENCY
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ id: 'task-1', user_id: 'profile-1', status: 'processing' }] };
      }
      throw new Error(`Unexpected client SQL: ${sql.slice(0, 80)}`);
    },
    release() {},
  };
}

function makeDb(activeCount) {
  return { getClient: async () => makeClient(activeCount) };
}

(async () => {
  assert.strictEqual(MAX_PROFILE_CONCURRENCY, 50);
  const claimed = await claimGenerationTask({
    taskId: 'task-1', jobId: 'job-1', leaseToken: '00000000-0000-0000-0000-000000000001',
    workerId: 'worker-1', leaseSeconds: 60, db: makeDb(4),
  });
  assert.strictEqual(claimed.claimed, true);
  assert.strictEqual(claimed.activeCount, 5);

  const deferred = await claimGenerationTask({
    taskId: 'task-1', jobId: 'job-2', leaseToken: '00000000-0000-0000-0000-000000000002',
    workerId: 'worker-1', leaseSeconds: 60, db: makeDb(5),
  });
  assert.strictEqual(deferred.claimed, false);
  assert.strictEqual(deferred.reason, 'profile_limit');
  assert.strictEqual(deferred.maxConcurrent, 5);

  console.log('generation admission claim test passed');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
