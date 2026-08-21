'use strict';

process.env.USER_TASK_GLOBAL_ADMISSION_ENABLED = '0';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
const calls = [];
const fakeDb = {
  async query(sql) {
    const table = String(sql).match(/FROM\s+([a-z_]+)/i)?.[1];
    if (table === 'info_article_tasks') {
      return { rows: [{ id: 'info-1', user_id: 'user-1' }] };
    }
    if (table === 'meta_tag_tasks') {
      return { rows: [{ id: 'meta-1', user_id: 'user-1' }] };
    }
    return { rows: [] };
  },
};

function fakePipeline(kind) {
  return {
    [`process${kind[0].toUpperCase()}${kind.slice(1)}Task`]: async () => {},
  };
}

const fakeInfo = { processInfoArticleTask: async (id) => { calls.push(`info:${id}`); } };
const fakeMeta = { processMetaTagTask: async (id) => { calls.push(`meta:${id}`); } };

Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === '../../config/db') return fakeDb;
  if (request === '../infoArticle/infoArticlePipeline') return fakeInfo;
  if (request === '../metaTags/pipeline') return fakeMeta;
  return originalLoad.apply(this, [request, parent, ...rest]);
};

(async () => {
  try {
    const recoveryPath = path.join(__dirname, '..', 'src', 'services', 'tasks', 'queuedTaskRecovery');
    delete require.cache[require.resolve(recoveryPath)];
    const { recoverQueuedUserTasks } = require(recoveryPath);
    const result = await recoverQueuedUserTasks(fakeDb);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(result.skipped, undefined);
    assert.strictEqual(calls.includes('info:info-1'), true);
    assert.strictEqual(calls.includes('meta:meta-1'), true);
    assert.strictEqual(calls.length, 2, 'each queued task must be launched exactly once');
    console.log('queued-task recovery regression: 6/6 passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
