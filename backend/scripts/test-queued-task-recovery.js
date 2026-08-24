'use strict';

process.env.USER_TASK_GLOBAL_ADMISSION_ENABLED = '0';

const assert = require('assert');
const Module = require('module');
const path = require('path');

const originalLoad = Module._load;
const calls = [];
const fakeDb = {
  async query(sql) {
    const text = String(sql);
    const table = text.match(/FROM\s+([a-z_]+)/i)?.[1];
    if (table === 'info_article_tasks') {
      return { rows: [{ id: 'info-1', user_id: 'user-1' }] };
    }
    if (table === 'meta_tag_tasks') {
      return { rows: [{ id: 'meta-1', user_id: 'user-1' }] };
    }
    if (table === 'relevance_reports'
      && /updated_at\s*<\s*NOW\(\)/i.test(text)
      && /current_stage::text\s*=\s*ANY/i.test(text)) {
      return {
        rows: [{ id: 'rel-1', user_id: 'user-1', status: 'fetching', current_stage: 'fetching_pages' }],
      };
    }
    if (/^\s*UPDATE\s+relevance_reports/i.test(text)
      && /current_stage::text\s*=\s*ANY/i.test(text)) {
      return { rows: [{ id: 'rel-1', user_id: 'user-1' }], rowCount: 1 };
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
const fakeRelevance = { processRelevanceReport: async (id) => { calls.push(`relevance:${id}`); } };

Module._load = function patchedLoad(request, parent, ...rest) {
  if (request === '../../config/db') return fakeDb;
  if (request === '../infoArticle/infoArticlePipeline') return fakeInfo;
  if (request === '../metaTags/pipeline') return fakeMeta;
  if (request === '../relevance/pipeline') return fakeRelevance;
  return originalLoad.apply(this, [request, parent, ...rest]);
};

(async () => {
  try {
    const recoveryPath = path.join(__dirname, '..', 'src', 'services', 'tasks', 'queuedTaskRecovery');
    delete require.cache[require.resolve(recoveryPath)];
    const { recoverQueuedUserTasks, recoverStaleActiveUserTasks } = require(recoveryPath);
    const result = await recoverQueuedUserTasks(fakeDb);
    const staleResult = await recoverStaleActiveUserTasks(fakeDb);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(result.skipped, undefined);
    assert.strictEqual(staleResult.skipped, undefined);
    assert.strictEqual(calls.includes('info:info-1'), true);
    assert.strictEqual(calls.includes('meta:meta-1'), true);
    assert.strictEqual(calls.includes('relevance:rel-1'), true);
    assert.strictEqual(calls.length, 3, 'each queued/stale task must be launched exactly once');
    console.log('queued-task recovery regression: 8/8 passed');
  } finally {
    Module._load = originalLoad;
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
