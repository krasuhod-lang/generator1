'use strict';

const assert = require('assert');
const { listAllItems } = require('../src/services/parserBot/queue');

function makeDb(total) {
  const items = Array.from({ length: total }, (_, i) => ({ id: i + 1 }));
  return {
    async query(sql, params) {
      if (/FROM parser_scan_tasks WHERE id=\$1 AND user_id=\$2/i.test(sql)) {
        return { rows: [{ id: params[0], user_id: params[1], status: 'done', total }] };
      }
      if (/SELECT id, task_id, input_url/i.test(sql)) {
        const limit = Number(params[params.length - 2]);
        const offset = Number(params[params.length - 1]);
        return { rows: items.slice(offset, offset + limit) };
      }
      throw new Error(`Unexpected SQL in test: ${sql.slice(0, 80)}`);
    },
  };
}

(async () => {
  const out = await listAllItems('task-1', 'u1', makeDb(1001));
  assert.strictEqual(out.length, 1001);
  assert.strictEqual(out[0].id, 1);
  assert.strictEqual(out[1000].id, 1001);
  console.log('parser export pagination test passed');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
