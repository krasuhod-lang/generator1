'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const tasksLog = require('../src/services/reports/tasksAutoLog');
const db = require('../src/config/db');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function testCanonicalSourceContract() {
  const source = read('backend/src/services/reports/tasksAutoLog.js');
  const taskSegment = tasksLog.MODULE_SEGMENTS.find((segment) => segment.table === 'tasks');
  assert.ok(taskSegment, 'legacy SEO tasks must be a report history source');
  assert.match(taskSegment.sql, /status::text = 'completed'/);
  assert.match(taskSegment.sql, /completed_at/);
  assert.match(taskSegment.sql, /AT TIME ZONE 'UTC'/);
  assert.doesNotMatch(taskSegment.sql, /COALESCE\(updated_at/);
  assert.match(source, /performed_at_ts/);
  assert.match(source, /performed_at_source/);
  assert.match(source, /pg_advisory_xact_lock/);
  assert.match(source, /SAVEPOINT tasks_auto_log_segment/);
  assert.match(source, /ROLLBACK TO SAVEPOINT tasks_auto_log_segment/);
  assert.match(source, /UPDATE tasks_auto_log l/);
}

function testControllerAndUiGuards() {
  const tasksController = read('backend/src/controllers/tasks.controller.js');
  const admission = read('backend/src/services/tasks/generationAdmission.js');
  const projectsController = read('backend/src/controllers/projects.controller.js');
  const dashboard = read('frontend/src/views/DashboardPage.vue');
  const projectDetail = read('frontend/src/views/ProjectDetailPage.vue');
  const migration = read('migrations/141_seo_task_integrity.sql');
  const server = read('backend/server.js');
  const sanitizer = read('backend/src/services/reports/viewModeSanitizer.js');
  const admin = read('backend/src/controllers/admin.controller.js');
  const taskStore = read('frontend/src/stores/tasks.js');

  assert.match(tasksController, /archived_at/);
  assert.match(tasksController, /UPDATE tasks[\s\S]*archived_at = COALESCE\(archived_at, NOW\(\)\)/);
  assert.match(tasksController, /completed_at=NULL/);
  assert.doesNotMatch(tasksController, /DELETE FROM tasks/);
  assert.match(admission, /archived_at IS NULL/);
  assert.match(projectsController, /'seo'::text AS type/);
  assert.match(projectsController, /COALESCE\(completed_at, created_at\) AS activity_at/);
  assert.match(projectsController, /ORDER BY activity_at DESC/);
  assert.match(projectDetail, /seo:\s+'SEO-текст'/);
  assert.match(projectDetail, /return `\/tasks\/\$\{t\.id\}\/\$\{suffix\}`/);
  assert.match(admin, /ORDER BY COALESCE\(t\.completed_at, t\.created_at\) DESC/);
  assert.match(dashboard, /function taskDateValue\(task\)/);
  assert.match(dashboard, /taskDateValue\(task\)/);
  assert.match(projectDetail, /function taskDateValue\(task\)/);
  assert.match(projectDetail, /formatDate\(taskDateValue\(t\)\)/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS archived_at/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS performed_at_ts/);
  assert.match(server, /ALTER TABLE tasks_auto_log ADD COLUMN IF NOT EXISTS performed_at_ts/);
  assert.match(sanitizer, /performed_at_ts: it\.performed_at_ts/);
  assert.match(admin, /user_task_history_preserved/);
  assert.match(admin, /SELECT COUNT\(\*\) FROM tasks WHERE user_id/);
  assert.match(taskStore, /soft archive/);
  assert.doesNotMatch(taskStore, /tasks\.value = tasks\.value\.filter\(t => t\.id !== id\)/);
}


async function testRecordTaskTimestamp() {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [{ id: 'log-1' }], rowCount: 1 };
  };
  try {
    const id = await tasksLog.recordTask({
      projectId: 'project-1',
      userId: 'user-1',
      taskType: 'content_generation',
      title: 'SEO text',
      performedAt: '2026-08-27T21:45:00+03:00',
      refTable: 'tasks',
      refId: 'task-1',
    });
    assert.strictEqual(id, 'log-1');
    assert.match(calls[0].sql, /performed_at_ts/);
    assert.match(calls[0].sql, /performed_at_source/);
    assert.strictEqual(calls[0].params[5], '2026-08-27');
    assert.strictEqual(calls[0].params[6], '2026-08-27T18:45:00.000Z');
  } finally {
    db.query = originalQuery;
  }
}

async function testSyncUsesAtomicSegments() {
  const originalQuery = db.query;
  const originalGetClient = db.getClient;
  const discoveryCalls = [];
  const clientCalls = [];
  db.query = async (sql, params) => {
    discoveryCalls.push({ sql, params });
    return { rows: [{ table_name: 'tasks' }, { table_name: 'info_article_tasks' }] };
  };
  db.getClient = async () => ({
    async query(sql, params) {
      clientCalls.push({ sql, params });
      if (sql.includes('FROM info_article_tasks')) throw new Error('legacy info schema mismatch');
      if (sql.startsWith('INSERT INTO tasks_auto_log')) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [] };
    },
    release() {},
  });
  try {
    const inserted = await tasksLog.syncFromModules('project-1');
    assert.strictEqual(inserted, 1);
    assert.ok(discoveryCalls.length >= 1);
    assert.ok(clientCalls.some((call) => call.sql.includes('UPDATE tasks_auto_log l')));
    assert.ok(clientCalls.some((call) => call.sql.includes('INSERT INTO tasks_auto_log')));
    assert.ok(clientCalls.some((call) => call.sql.includes('ROLLBACK TO SAVEPOINT tasks_auto_log_segment')));
    assert.ok(clientCalls.some((call) => call.sql.includes('AT TIME ZONE \'UTC\'')));
  } finally {
    db.query = originalQuery;
    db.getClient = originalGetClient;
  }
}

(async () => {
  testCanonicalSourceContract();
  testControllerAndUiGuards();
  await testRecordTaskTimestamp();
  await testSyncUsesAtomicSegments();
  console.log('seo-task-integrity: 24/24 passed');
})().catch((error) => {
  console.error(`seo-task-integrity: FAILED — ${error.stack || error.message}`);
  process.exitCode = 1;
});
