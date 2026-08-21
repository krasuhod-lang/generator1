'use strict';

const assert = require('assert');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');

const { walkOldFiles, cleanupStorage } = require('../src/services/maintenance/storageAdmin');
const { runStorageRetention } = require('../src/services/maintenance/storageRetention');
const { requeueActiveUserTasksForShutdown } = require('../src/services/tasks/queuedTaskRecovery');

(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'generator-storage-test-'));
  const oldFile = path.join(root, 'old.log');
  const newFile = path.join(root, 'new.log');
  await fsp.writeFile(oldFile, 'old');
  await fsp.writeFile(newFile, 'new');
  const oldTime = Date.now() - 40 * 24 * 60 * 60 * 1000;
  await fsp.utimes(oldFile, oldTime / 1000, oldTime / 1000);

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const preview = await walkOldFiles(root, cutoff, true);
  assert.strictEqual(preview.deleted, 0, 'dry-run must not delete files');
  assert.strictEqual(fs.existsSync(oldFile), true, 'dry-run must preserve old file');

  const cleaned = await walkOldFiles(root, cutoff, false);
  assert.strictEqual(cleaned.deleted, 1, 'real folder cleanup should delete one old file');
  assert.strictEqual(fs.existsSync(oldFile), false, 'old file should be deleted');
  assert.strictEqual(fs.existsSync(newFile), true, 'new file must remain');

  const sqlCalls = [];
  const fakeDb = {
    async query(sql) {
      sqlCalls.push(sql);
      if (/SELECT id FROM parser_tasks/i.test(sql)) return { rows: [] };
      if (/SELECT id, input_tz_docx_path/i.test(sql)) return { rows: [] };
      if (/SELECT id FROM custom_tasks/i.test(sql)) return { rows: [{ id: 'old-task' }] };
      if (/DELETE FROM custom_tasks/i.test(sql)) return { rowCount: 1 };
      if (/VACUUM/i.test(sql)) return { rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
  const retention = await runStorageRetention(
    { dryRun: true, retentionDays: 30, failedDays: 30, vacuum: true },
    {
      db: fakeDb,
      cleanup: async () => { throw new Error('dry-run called cleanup'); },
      tables: [{
        table: 'custom_tasks',
        idCol: 'id',
        successStatuses: ['done'],
        completedAgeExpr: 'updated_at',
        failedAgeExpr: 'updated_at',
        docxCol: null,
        hasImageDir: false,
      }],
    },
  );
  assert.strictEqual(retention.config.dryRun, true);
  assert.strictEqual(sqlCalls.some((sql) => /DELETE FROM/i.test(sql)), false, 'retention preview must not delete rows');
  assert.strictEqual(sqlCalls.some((sql) => /VACUUM/i.test(sql)), false, 'retention preview must not vacuum');

  const shutdownCalls = [];
  const shutdownDb = {
    async query(sql, params) {
      shutdownCalls.push({ sql, params });
      if (/UPDATE .*info_article_tasks/i.test(sql)) return { rowCount: 2 };
      if (/UPDATE .*link_article_tasks/i.test(sql)) return { rowCount: 1 };
      if (/relation .* does not exist/i.test(sql)) return { rowCount: 0 };
      return { rowCount: 0 };
    },
  };
  const requeued = await requeueActiveUserTasksForShutdown(shutdownDb);
  assert.strictEqual(requeued.requeued, 3, 'shutdown requeue should count direct tasks');
  assert.ok(shutdownCalls.some((call) => call.sql.includes("status = $1")), 'shutdown should issue status requeue updates');

  await fsp.rm(root, { recursive: true, force: true });
  let rejected = false;
  try { await cleanupStorage({ scope: 'brain_state', dryRun: true }); } catch (_) { rejected = true; }
  assert.strictEqual(rejected, true, 'brain_state must not be an allowed cleanup scope');

  try {
    const queues = require('../src/queue/queue');
    await Promise.all(Object.values(queues)
      .filter((queue) => queue && typeof queue.close === 'function')
      .map((queue) => queue.close()));
  } catch (_) {}
  console.log('storage/restart safety regression: 10/10');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
