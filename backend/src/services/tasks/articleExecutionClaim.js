const crypto = require('crypto');
const dbDefault = require('../../config/db');

const TABLES = new Set(['info_article_tasks', 'link_article_tasks']);

function assertTable(table) {
  if (!TABLES.has(table)) throw new Error(`Unsupported article task table: ${table}`);
}

/**
 * Atomically claims one blog/link task for a single process.
 * A second process cannot claim a row that is already running/done/error.
 */
async function claimArticleTask({ table, taskId, db = dbDefault }) {
  assertTable(table);
  const executionToken = crypto.randomUUID();
  const { rows } = await db.query(
    `UPDATE ${table}
        SET status = 'running',
            started_at = COALESCE(started_at, NOW()),
            progress_pct = 1,
            error_message = NULL,
            execution_token = $2::uuid,
            execution_started_at = NOW(),
            updated_at = NOW()
      WHERE id = $1
        AND status IN ('queued', 'pending')
      RETURNING *`,
    [taskId, executionToken],
  );
  if (!rows.length) return null;
  return { task: rows[0], executionToken };
}

module.exports = { claimArticleTask, TABLES };
