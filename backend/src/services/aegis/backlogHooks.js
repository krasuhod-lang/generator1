'use strict';

const db = require('../../config/db');
const githubBot = require('./githubBot');

const LABEL_READY = 'aegis:ready';
const LABEL_IN_PROGRESS = 'aegis:in-progress';
const LABEL_DONE = 'aegis:done';
const LABEL_FAILED = 'aegis:failed';

async function markIssueInProgress(issueNumber) {
  if (!issueNumber) return;
  await githubBot.addLabel({ issueNumber, label: LABEL_IN_PROGRESS });
  await githubBot.removeLabel({ issueNumber, label: LABEL_READY });
}

async function _setFinalLabels(issueNumber, ok) {
  if (!issueNumber) return;
  await githubBot.removeLabel({ issueNumber, label: LABEL_IN_PROGRESS });
  await githubBot.removeLabel({ issueNumber, label: ok ? LABEL_FAILED : LABEL_DONE });
  await githubBot.addLabel({ issueNumber, label: ok ? LABEL_DONE : LABEL_FAILED });
}

async function finalizeBacklogIssue({
  issueNumber,
  ok,
  status,
  taskRef,
  taskKind,
  spqOverall = null,
  error = null,
  comment = '',
}) {
  if (!issueNumber) return;

  await db.query(
    `INSERT INTO aegis_backlog (issue_number, title, labels, status)
     VALUES ($1, '', '[]'::jsonb, $2)
     ON CONFLICT (issue_number)
     DO UPDATE SET status = $2,
                   task_ref = COALESCE($3, aegis_backlog.task_ref),
                   task_kind = COALESCE($4, aegis_backlog.task_kind),
                   spq_overall = COALESCE($5, aegis_backlog.spq_overall),
                   error = $6,
                   finished_at = NOW(),
                   updated_at = NOW()`,
    [issueNumber, status, taskRef || null, taskKind || null, spqOverall, error || null],
  );

  await _setFinalLabels(issueNumber, ok);

  if (comment) {
    await githubBot.commentIssue({
      issueNumber,
      body: comment,
    });
  }
}

async function finalizeByTask({ table, taskId, ok, spqOverall = null, error = null, taskKind }) {
  const { rows } = await db.query(
    `SELECT aegis_issue_number FROM ${table} WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  const issueNumber = rows[0] && rows[0].aegis_issue_number;
  if (!issueNumber) return;

  const status = ok ? 'done' : 'failed';
  const comment = ok
    ? `✅ AEGIS completed **${taskKind}** task \`${taskId}\`${spqOverall != null ? ` (Spq ${Number(spqOverall).toFixed(1)})` : ''}.`
    : `❌ AEGIS failed **${taskKind}** task \`${taskId}\`: ${String(error || 'unknown error').slice(0, 500)}`;

  await finalizeBacklogIssue({
    issueNumber,
    ok,
    status,
    taskRef: taskId,
    taskKind,
    spqOverall,
    error,
    comment,
  });
}

module.exports = {
  LABEL_READY,
  LABEL_IN_PROGRESS,
  LABEL_DONE,
  LABEL_FAILED,
  markIssueInProgress,
  finalizeBacklogIssue,
  finalizeByTask,
};
