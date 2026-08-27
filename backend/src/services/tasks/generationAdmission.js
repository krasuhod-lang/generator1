'use strict';

const dbDefault = require('../../config/db');

const MAX_PROFILE_CONCURRENCY = Math.max(
  5,
  Math.min(50, Number(process.env.GENERATION_MAX_PER_PROFILE) || 5),
);
const PROFILE_LOCK_PREFIX = 'generator-profile-slots:';

function profileLockKey(userId) {
  return `${PROFILE_LOCK_PREFIX}${userId}`;
}

/**
 * Claims a generation task and its lease atomically with the per-profile slot.
 * PostgreSQL advisory-xact locking serializes claims for one user across all
 * worker processes/containers, while different users can claim concurrently.
 */
async function claimGenerationTask({
  taskId,
  jobId,
  leaseToken,
  workerId,
  leaseSeconds,
  db = dbDefault,
}) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const taskResult = await client.query(
      `SELECT id, user_id, status, lease_until
         FROM tasks
        WHERE id=$1
        FOR UPDATE`,
      [taskId],
    );
    if (!taskResult.rows.length) {
      const error = new Error(`Task ${taskId} not found in DB`);
      error.code = 'task_not_found';
      throw error;
    }

    const task = taskResult.rows[0];
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext($1))`,
      [profileLockKey(task.user_id)],
    );

    const activeResult = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM tasks
        WHERE user_id=$1
          AND status='processing'
          AND lease_until > NOW()`,
      [task.user_id],
    );
    const activeCount = Number(activeResult.rows[0]?.count || 0);
    if (activeCount >= MAX_PROFILE_CONCURRENCY) {
      await client.query('COMMIT');
      return {
        claimed: false,
        reason: 'profile_limit',
        userId: task.user_id,
        activeCount,
        maxConcurrent: MAX_PROFILE_CONCURRENCY,
      };
    }

    const claimedResult = await client.query(
      `UPDATE tasks
          SET status='processing', started_at=COALESCE(started_at,NOW()),
              bull_job_id=$2, worker_id=$3, lease_token=$4::uuid,
              lease_until=NOW()+make_interval(secs => $5), heartbeat_at=NOW(),
              last_error_code=NULL, updated_at=NOW()
        WHERE id=$1
          AND archived_at IS NULL
          AND status IN ('queued','processing')
          AND (status='queued' OR lease_until IS NULL OR lease_until < NOW())
        RETURNING *`,
      [taskId, String(jobId), workerId, leaseToken, leaseSeconds],
    );
    await client.query('COMMIT');

    if (!claimedResult.rows.length) {
      return {
        claimed: false,
        reason: 'lease_not_acquired',
        userId: task.user_id,
        activeCount,
        maxConcurrent: MAX_PROFILE_CONCURRENCY,
      };
    }
    return {
      claimed: true,
      task: claimedResult.rows[0],
      userId: task.user_id,
      activeCount: activeCount + 1,
      maxConcurrent: MAX_PROFILE_CONCURRENCY,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function getProfileQueueHealth(userId, taskId = null, db = dbDefault) {
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE status='processing'
           AND lease_until > NOW()
       )::int AS active_count,
       COUNT(*) FILTER (WHERE status='queued')::int AS queued_count,
       COUNT(*) FILTER (WHERE status='queued' AND created_at <= (
         SELECT created_at FROM tasks WHERE id=$2
       ))::int AS queued_before_task
       FROM tasks
      WHERE user_id=$1`,
    [userId, taskId],
  );
  const row = rows[0] || {};
  const activeCount = Number(row.active_count || 0);
  return {
    maxConcurrent: MAX_PROFILE_CONCURRENCY,
    activeCount,
    availableSlots: Math.max(0, MAX_PROFILE_CONCURRENCY - activeCount),
    queuedCount: Number(row.queued_count || 0),
    queuedBeforeTask: Number(row.queued_before_task || 0),
  };
}

module.exports = {
  MAX_PROFILE_CONCURRENCY,
  claimGenerationTask,
  getProfileQueueHealth,
};
