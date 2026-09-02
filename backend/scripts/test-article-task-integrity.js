#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { claimArticleTask } = require('../src/services/tasks/articleExecutionClaim');

const root = path.resolve(__dirname, '../..');

async function testClaimIsAtomic() {
  const calls = [];
  let first = true;
  const fakeDb = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (first) {
        first = false;
        return { rows: [{ id: params[0], status: 'running', topic: 'Immutable article' }] };
      }
      return { rows: [] };
    },
  };

  const claimed = await claimArticleTask({
    table: 'info_article_tasks',
    taskId: 'task-1',
    db: fakeDb,
  });
  assert.ok(claimed, 'first queued task must be claimed');
  assert.match(claimed.executionToken, /^[0-9a-f-]{36}$/i, 'claim token must be UUID');
  assert.equal(claimed.task.id, 'task-1');
  assert.match(calls[0].sql, /status = 'queued'/);
  assert.doesNotMatch(calls[0].sql, /status IN \\('queued', 'pending'\\)/);
  assert.match(calls[0].sql, /execution_token = \$2::uuid/);

  const duplicate = await claimArticleTask({
    table: 'info_article_tasks',
    taskId: 'task-1',
    db: fakeDb,
  });
  assert.equal(duplicate, null, 'second process must not claim a running/done task');
}

async function testUnsupportedTableRejected() {
  await assert.rejects(
    () => claimArticleTask({ table: 'tasks', taskId: 'task-1', db: { query: async () => ({ rows: [] }) } }),
    /Unsupported article task table/,
  );
}

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function testProductionGuards() {
  const info = read('backend/src/services/infoArticle/infoArticlePipeline.js');
  const link = read('backend/src/services/linkArticle/linkArticlePipeline.js');
  const durable = read('backend/src/services/tasks/durableSchema.js');
  const recovery = read('backend/src/services/tasks/queuedTaskRecovery.js');
  const admission = read('backend/src/services/tasks/userTaskAdmission.js');
  const scheduler = read('backend/src/utils/perUserConcurrency.js');
  const infoStore = read('frontend/src/stores/infoArticle.js');
  const linkStore = read('frontend/src/stores/linkArticle.js');
  const infoPage = read('frontend/src/views/InfoArticlePage.vue');
  const linkPage = read('frontend/src/views/LinkArticlePage.vue');

  for (const [name, source] of [['info pipeline', info], ['link pipeline', link]]) {
    assert.match(source, /claimArticleTask/);
    assert.match(source, /execution_token = \$(?:9|10)::uuid/);
    assert.match(source, /claim lost before final write/);
    assert.match(source, /execution_token = NULL/);
  }
  assert.match(durable, /info_article_tasks ADD COLUMN IF NOT EXISTS execution_token UUID/);
  assert.match(durable, /link_article_tasks ADD COLUMN IF NOT EXISTS execution_token UUID/);
  assert.match(recovery, /claimColumns: true/);
  assert.match(admission, /reason: 'task_already_leased'/);
  assert.match(admission, /if \(result\.reason === 'task_already_leased'\)/);
  assert.match(scheduler, /if \(!slot\.claimed\)/);
  assert.match(scheduler, /reason: slot\.reason/);
  assert.match(infoStore, /loadMoreTasks/);
  assert.match(linkStore, /loadMoreTasks/);
  for (const [name, source] of [['info page', infoPage], ['link page', linkPage]]) {
    assert.match(source, /filterAndSortTasks/);
    assert.match(source, /groupTasksByDate/);
    assert.match(source, /fresh\.updated_at !== selectedTask\.value\.updated_at/);
    assert.match(source, /Показать более старые задачи/);
  }
}

(async () => {
  await testClaimIsAtomic();
  await testUnsupportedTableRejected();
  testProductionGuards();
  console.log('article-task-integrity: 18/18 passed');
})().catch((error) => {
  console.error(`article-task-integrity: FAILED — ${error.message}`);
  process.exitCode = 1;
});
