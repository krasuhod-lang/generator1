'use strict';

const crypto = require('crypto');
const dbDefault = require('../../config/db');

const MAX_USER_TASKS = 5;
const LEASE_SECONDS = Math.max(30, Number(process.env.USER_TASK_LEASE_SECONDS) || 90);
const POLL_INTERVAL_MS = Math.max(250, Number(process.env.USER_TASK_SLOT_POLL_MS) || 1000);
const GLOBAL_ADMISSION_ENABLED = String(process.env.USER_TASK_GLOBAL_ADMISSION_ENABLED || 'true').toLowerCase()
  .trim() !== 'false' && String(process.env.USER_TASK_GLOBAL_ADMISSION_ENABLED || 'true').trim() !== '0';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockKey(userId) {
  return `user-task-admission:${String(userId)}`;
}

async function tryAcquireUserTaskSlot({ userId, taskType, taskId, db = dbDefault }) {
  if (!GLOBAL_ADMISSION_ENABLED) {
    return { claimed: true, bypassed: true, slotToken: null };
  }
  if (userId == null || userId === '') {
    return { claimed: false, reason: 'user_id_missing' };
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey(userId)]);
    await client.query(
      `DELETE FROM user_task_slot_leases WHERE user_id=$1 AND lease_until <= NOW()`,
      [userId],
    );

    const existing = await client.query(
      `SELECT slot_token FROM user_task_slot_leases
        WHERE user_id=$1 AND task_type=$2 AND task_id=$3
        LIMIT 1`,
      [userId, String(taskType || 'task'), String(taskId)],
    );
    if (existing.rows.length) {
      const slotToken = existing.rows[0].slot_token;
      await client.query(
        `UPDATE user_task_slot_leases
            SET lease_until=NOW()+make_interval(secs => $2), heartbeat_at=NOW()
          WHERE slot_token=$1`,
        [slotToken, LEASE_SECONDS],
      );
      await client.query('COMMIT');
      // Один и тот же task_id уже выполняется другим процессом. Не передаём
      // повторному launcher право запускать pipeline и не даём ему release чужого lease.
      return { claimed: false, reason: 'task_already_leased', slotToken, reused: true };
    }

    const count = await client.query(
      `SELECT COUNT(*)::int AS count
         FROM user_task_slot_leases
        WHERE user_id=$1 AND lease_until > NOW()`,
      [userId],
    );
    const activeCount = Number(count.rows[0]?.count || 0);
    if (activeCount >= MAX_USER_TASKS) {
      await client.query('COMMIT');
      return {
        claimed: false,
        reason: 'user_limit',
        activeCount,
        maxConcurrent: MAX_USER_TASKS,
      };
    }

    const inserted = await client.query(
      `INSERT INTO user_task_slot_leases
         (user_id, task_type, task_id, lease_until, heartbeat_at)
       VALUES ($1, $2, $3, NOW()+make_interval(secs => $4), NOW())
       RETURNING slot_token`,
      [userId, String(taskType || 'task'), String(taskId), LEASE_SECONDS],
    );
    await client.query('COMMIT');
    return {
      claimed: true,
      slotToken: inserted.rows[0].slot_token,
      activeCount: activeCount + 1,
      maxConcurrent: MAX_USER_TASKS,
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function renewUserTaskSlot(slotToken, db = dbDefault) {
  if (!slotToken || !GLOBAL_ADMISSION_ENABLED) return true;
  const { rowCount } = await db.query(
    `UPDATE user_task_slot_leases
        SET lease_until=NOW()+make_interval(secs => $2), heartbeat_at=NOW()
      WHERE slot_token=$1`,
    [slotToken, LEASE_SECONDS],
  );
  return rowCount === 1;
}

async function releaseUserTaskSlot(slotToken, db = dbDefault) {
  if (!slotToken || !GLOBAL_ADMISSION_ENABLED) return;
  await db.query(`DELETE FROM user_task_slot_leases WHERE slot_token=$1`, [slotToken]);
}

async function acquireUserTaskSlot({ userId, taskType, taskId, db = dbDefault, maxWaitMs = 0 }) {
  const startedAt = Date.now();
  while (true) {
    const result = await tryAcquireUserTaskSlot({ userId, taskType, taskId, db });
    if (result.reason === 'task_already_leased') {
      return {
        ...result,
        waitedMs: Date.now() - startedAt,
        release: async () => {},
      };
    }
    if (result.claimed) {
      let released = false;
      const heartbeat = setInterval(() => {
        renewUserTaskSlot(result.slotToken, db).catch((error) => {
          console.warn('[UserTaskAdmission] heartbeat failed:', error.message);
        });
      }, Math.max(5000, Math.floor((LEASE_SECONDS * 1000) / 3)));
      if (heartbeat.unref) heartbeat.unref();
      return {
        ...result,
        waitedMs: Date.now() - startedAt,
        release: async () => {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          await releaseUserTaskSlot(result.slotToken, db);
        },
      };
    }
    if (maxWaitMs > 0 && Date.now() - startedAt >= maxWaitMs) {
      return { ...result, waitedMs: Date.now() - startedAt, release: async () => {} };
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function getUserTaskSlotHealth(userId, db = dbDefault) {
  if (!GLOBAL_ADMISSION_ENABLED) {
    return { activeCount: 0, availableSlots: MAX_USER_TASKS, maxConcurrent: MAX_USER_TASKS };
  }
  await db.query(`DELETE FROM user_task_slot_leases WHERE user_id=$1 AND lease_until <= NOW()`, [userId]);
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM user_task_slot_leases
      WHERE user_id=$1 AND lease_until > NOW()`,
    [userId],
  );
  const activeCount = Number(rows[0]?.count || 0);
  return {
    activeCount,
    availableSlots: Math.max(0, MAX_USER_TASKS - activeCount),
    maxConcurrent: MAX_USER_TASKS,
  };
}

async function withUserTaskLease({ userId, taskType, taskId, fn, db = dbDefault, maxWaitMs = 0 }) {
  const slot = await acquireUserTaskSlot({ userId, taskType, taskId, db, maxWaitMs });
  if (!slot.claimed) return { admitted: false, reason: slot.reason, activeCount: slot.activeCount };
  try {
    return { admitted: true, result: await fn(), waitedMs: slot.waitedMs };
  } finally {
    await slot.release().catch((error) => {
      console.warn('[UserTaskAdmission] release failed:', error.message);
    });
  }
}

module.exports = {
  MAX_USER_TASKS,
  LEASE_SECONDS,
  GLOBAL_ADMISSION_ENABLED,
  tryAcquireUserTaskSlot,
  acquireUserTaskSlot,
  renewUserTaskSlot,
  releaseUserTaskSlot,
  getUserTaskSlotHealth,
  withUserTaskLease,
};
