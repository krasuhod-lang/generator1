'use strict';

const db = require('../../config/db');
const { withUserSlot } = require('../../utils/perUserConcurrency');
const { processInfoArticleTask } = require('../infoArticle/infoArticlePipeline');
const { processLinkArticleTask } = require('../linkArticle/linkArticlePipeline');
const { processMetaTagTask } = require('../metaTags/pipeline');
const { processRelevanceReport } = require('../relevance/pipeline');

const AEGIS_SYSTEM_EMAIL = 'targetlid1@yandex.ru';

async function _resolveSystemUserId() {
  const byEmail = await db.query(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [AEGIS_SYSTEM_EMAIL],
  );
  if (byEmail.rows.length) return byEmail.rows[0].id;
  const byRole = await db.query(
    `SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1`,
  );
  if (byRole.rows.length) return byRole.rows[0].id;
  return null;
}

async function _createInfoArticle({ userId, payload, issueNumber }) {
  const { rows } = await db.query(
    `INSERT INTO info_article_tasks
       (user_id, topic, region, brand_name, author_name, brand_facts,
        output_format, commercial_links, commercial_links_count, gemini_model,
        status, progress_pct, source, aegis_issue_number)
     VALUES ($1, $2, $3, NULL, NULL, NULL,
             'html', '[]'::jsonb, 0, 'gemini-3.1-pro-preview',
             'queued', 0, 'aegis_backlog', $4)
     RETURNING id`,
    [userId, payload.query, payload.niche || 'Россия', issueNumber],
  );
  const taskId = rows[0].id;
  setImmediate(() => {
    withUserSlot(userId, () => processInfoArticleTask(taskId)).catch((err) => {
      console.error('[aegis/backlog] info_article failed:', err.message);
    });
  });
  return { taskRef: taskId, taskKind: 'info_article' };
}

async function _createLinkArticle({ userId, payload, issueNumber }) {
  const anchorUrl = /^https?:\/\//i.test(payload.anchor_url || '')
    ? payload.anchor_url
    : 'https://example.com';
  const { rows } = await db.query(
    `INSERT INTO link_article_tasks
       (user_id, topic, anchor_text, anchor_url, focus_notes,
        output_format, gemini_model, status, progress_pct, source, aegis_issue_number)
     VALUES ($1, $2, $3, $4, $5,
             'html', 'gemini-3.1-pro-preview', 'queued', 0, 'aegis_backlog', $6)
     RETURNING id`,
    [
      userId,
      payload.query,
      payload.anchor_text || payload.query,
      anchorUrl,
      payload.notes || '',
      issueNumber,
    ],
  );
  const taskId = rows[0].id;
  setImmediate(() => {
    withUserSlot(userId, () => processLinkArticleTask(taskId)).catch((err) => {
      console.error('[aegis/backlog] link_article failed:', err.message);
    });
  });
  return { taskRef: taskId, taskKind: 'link_article' };
}

async function _createMetaTags({ userId, payload, issueNumber }) {
  const keyword = payload.query;
  const { rows } = await db.query(
    `INSERT INTO meta_tag_tasks
       (user_id, name, niche, lr, keywords,
        status, progress_total, llm_provider, gemini_model, source, aegis_issue_number)
     VALUES ($1, $2, $3, $4, $5::jsonb,
             'pending', 1, 'gemini', 'gemini-3.1-pro-preview', 'aegis_backlog', $6)
     RETURNING id`,
    [
      userId,
      `AEGIS: ${payload.query}`.slice(0, 200),
      payload.niche || '',
      payload.lr || '213',
      JSON.stringify([keyword]),
      issueNumber,
    ],
  );
  const taskId = rows[0].id;
  setImmediate(() => {
    withUserSlot(userId, () => processMetaTagTask(taskId)).catch((err) => {
      console.error('[aegis/backlog] meta_tags failed:', err.message);
    });
  });
  return { taskRef: taskId, taskKind: 'meta_tags' };
}

async function _createRelevance({ userId, payload, issueNumber }) {
  const { rows } = await db.query(
    `INSERT INTO relevance_reports
       (user_id, query, lr, top_n, status, source, aegis_issue_number)
     VALUES ($1, $2, $3, $4, 'pending', 'aegis_backlog', $5)
     RETURNING id`,
    [userId, payload.query, payload.lr || '213', payload.top_n || 20, issueNumber],
  );
  const reportId = rows[0].id;
  setImmediate(() => {
    withUserSlot(userId, () => processRelevanceReport(reportId)).catch((err) => {
      console.error('[aegis/backlog] relevance failed:', err.message);
    });
  });
  return { taskRef: reportId, taskKind: 'relevance' };
}

async function dispatchBacklogItem({ kind, payload, issueNumber, issueTitle }) {
  const userId = await _resolveSystemUserId();
  if (!userId) {
    return { ok: false, reason: 'system_user_missing' };
  }

  await db.query(
    `INSERT INTO aegis_backlog (issue_number, title, labels, status)
     VALUES ($1, $2, '[]'::jsonb, 'processing')
     ON CONFLICT (issue_number)
     DO UPDATE SET status='processing', updated_at=NOW(), title=EXCLUDED.title`,
    [issueNumber, String(issueTitle || payload.query || '').slice(0, 500)],
  );

  let created;
  if (kind === 'info-article') created = await _createInfoArticle({ userId, payload, issueNumber });
  else if (kind === 'link-article') created = await _createLinkArticle({ userId, payload, issueNumber });
  else if (kind === 'meta-tags') created = await _createMetaTags({ userId, payload, issueNumber });
  else if (kind === 'relevance') created = await _createRelevance({ userId, payload, issueNumber });
  else return { ok: false, reason: `unsupported_kind:${kind}` };

  await db.query(
    `UPDATE aegis_backlog
        SET task_ref = $2,
            task_kind = $3,
            picked_at = NOW(),
            picked_by = 'aegis_backlog_worker',
            updated_at = NOW()
      WHERE issue_number = $1`,
    [issueNumber, created.taskRef, created.taskKind],
  );

  return { ok: true, ...created };
}

module.exports = { dispatchBacklogItem, _resolveSystemUserId };
