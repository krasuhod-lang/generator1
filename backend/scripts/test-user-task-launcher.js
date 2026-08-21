'use strict';

process.env.USER_TASK_GLOBAL_ADMISSION_ENABLED = '0';

const assert = require('assert');
const {
  MAX_PER_USER,
  withUserSlot,
  scheduleUserTask,
  getUserSlotStats,
} = require('../src/utils/perUserConcurrency');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  assert.strictEqual(MAX_PER_USER, 5, 'user task limit must be exactly 5');

  let active = 0;
  let maxActive = 0;
  const starts = [];
  const jobs = Array.from({ length: 6 }, (_, index) => withUserSlot('launcher-test-user', async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    starts.push(index);
    await sleep(15);
    active -= 1;
    return index;
  }));

  const results = await Promise.all(jobs);
  assert.deepStrictEqual(results, [0, 1, 2, 3, 4, 5]);
  assert.strictEqual(maxActive, 5, 'only five tasks may be active at once');
  assert.deepStrictEqual(starts.slice(0, 5), [0, 1, 2, 3, 4], 'first five tasks start FIFO');
  assert.strictEqual(starts[5], 5, 'sixth task starts after a slot is released');
  assert.deepStrictEqual(getUserSlotStats('launcher-test-user'), { active: 0, queued: 0, max: 5 });

  let executions = 0;
  const first = scheduleUserTask('launcher-test-user', 'info_article', 'same-task', async () => {
    executions += 1;
    await sleep(10);
    return 'ok';
  });
  const second = scheduleUserTask('launcher-test-user', 'info_article', 'same-task', async () => {
    executions += 100;
    return 'duplicate-must-not-run';
  });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepStrictEqual(firstResult, { scheduled: true, result: 'ok' });
  assert.deepStrictEqual(secondResult, { scheduled: false, duplicate: true });
  assert.strictEqual(executions, 1, 'POST and recovery must not execute one task twice');

  console.log('user-task launcher regression: 10/10 passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
