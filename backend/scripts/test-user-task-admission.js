'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

process.env.USER_TASK_GLOBAL_ADMISSION_ENABLED = 'true';

const leases = new Map();
const originalLoad = Module._load;

function fakeResult(sql, params) {
  const text = String(sql);
  if (/DELETE FROM user_task_slot_leases WHERE user_id/i.test(text)) {
    // Test leases never expire during this deterministic run.
    return { rows: [], rowCount: 0 };
  }
  if (/SELECT slot_token FROM user_task_slot_leases/i.test(text)) {
    const [userId, taskType, taskId] = params;
    for (const [slotToken, lease] of leases) {
      if (lease.userId === String(userId) && lease.taskType === String(taskType) && lease.taskId === String(taskId)) {
        return { rows: [{ slot_token: slotToken }] };
      }
    }
    return { rows: [] };
  }
  if (/SELECT COUNT\(\*\)[\s\S]*user_task_slot_leases/i.test(text)) {
    const userId = String(params[0]);
    return { rows: [{ count: [...leases.values()].filter((lease) => lease.userId === userId).length }] };
  }
  if (/INSERT INTO user_task_slot_leases/i.test(text)) {
    const token = `slot-${leases.size + 1}`;
    leases.set(token, {
      userId: String(params[0]),
      taskType: String(params[1]),
      taskId: String(params[2]),
    });
    return { rows: [{ slot_token: token }], rowCount: 1 };
  }
  if (/UPDATE user_task_slot_leases/i.test(text)) return { rows: [], rowCount: 1 };
  if (/DELETE FROM user_task_slot_leases WHERE slot_token/i.test(text)) {
    const removed = leases.delete(String(params[0]));
    return { rows: [], rowCount: removed ? 1 : 0 };
  }
  return { rows: [], rowCount: 0 };
}

const fakeDb = {
  async getClient() {
    return {
      async query(sql, params) {
        if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(String(sql).trim())) return { rows: [], rowCount: 0 };
        return fakeResult(sql, params);
      },
      release() {},
    };
  },
  async query(sql, params) {
    return fakeResult(sql, params);
  },
};

Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === '../../config/db') return fakeDb;
  return originalLoad.apply(this, [request, parent, ...rest]);
};

(async () => {
  try {
    const admissionPath = path.join(__dirname, '..', 'src', 'services', 'tasks', 'userTaskAdmission');
    delete require.cache[require.resolve(admissionPath)];
    const admission = require(admissionPath);
    const slots = [];
    for (let index = 0; index < 5; index += 1) {
      slots.push(await admission.acquireUserTaskSlot({
        userId: 'user-1', taskType: 'test', taskId: `task-${index}`,
        db: fakeDb,
      }));
    }
    assert.strictEqual(leases.size, 5);
    const sixth = await admission.acquireUserTaskSlot({
      userId: 'user-1', taskType: 'test', taskId: 'task-5', db: fakeDb, maxWaitMs: 1,
    });
    assert.strictEqual(sixth.claimed, false);
    assert.strictEqual(sixth.reason, 'user_limit');

    const reused = await admission.acquireUserTaskSlot({
      userId: 'user-1', taskType: 'test', taskId: 'task-0', db: fakeDb,
    });
    assert.strictEqual(reused.claimed, true);
    assert.strictEqual(reused.reused, true);
    await reused.release();
    await Promise.all(slots.map((slot) => slot.release()));
    assert.strictEqual(leases.size, 0);
    console.log('distributed user-task admission regression: 12/12 passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
