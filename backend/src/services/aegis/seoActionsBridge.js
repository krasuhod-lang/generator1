'use strict';

/**
 * Phase C2 — мост между SEO Brain action_plan и Aegis backlog (GitHub issues).
 *
 * Раз в N минут выбирает из aegis_seo_actions записи:
 *   • status = 'recommended'
 *   • priority >= 80
 *   • payload->>'low_risk' = 'true'
 *
 * Для каждой создаёт GitHub issue с label `aegis:ready`, после чего ставит
 * status='dispatched' и сохраняет номер issue в payload.dispatched_issue.
 *
 * Запуск — через любую ночную cron / отдельный setInterval. Поллер защищён
 * pg_advisory_lock (как backlogWorker), чтобы при нескольких репликах issue
 * не создавался дважды.
 */

const db = require('../../config/db');
const githubBot = require('./githubBot');

const LOCK_KEY = 7340021; // случайный int4
const DEFAULT_LIMIT = 5;
const READY_LABEL = 'aegis:ready';

function _renderIssueBody(action) {
  const p = action.payload || {};
  const parts = [];
  parts.push(`**Источник:** Aegis SEO Brain (автогенерация)`);
  parts.push(`**Site:** ${action.site_key}`);
  parts.push(`**Тип действия:** \`${action.action_type}\``);
  parts.push(`**Priority:** ${action.priority}`);
  if (action.target_url) parts.push(`**URL:** ${action.target_url}`);
  if (action.cluster) parts.push(`**Cluster:** ${action.cluster}`);
  if (action.intent) parts.push(`**Intent:** ${action.intent}`);
  if (p.reason) {
    parts.push('');
    parts.push(`**Причина:** ${p.reason}`);
  }
  if (p.evidence && typeof p.evidence === 'object') {
    parts.push('');
    parts.push('**Evidence:**');
    parts.push('```json');
    parts.push(JSON.stringify(p.evidence, null, 2).slice(0, 2000));
    parts.push('```');
  }
  parts.push('');
  parts.push(`<sub>action_key: \`${action.action_key}\` · low_risk · auto-dispatched by SEO Brain</sub>`);
  return parts.join('\n');
}

function _renderIssueTitle(action) {
  const url = action.target_url ? ` (${action.target_url})` : '';
  return `[SEO Brain] ${action.action_type}${url}`;
}

async function _withLock(fn) {
  if (typeof db.query !== 'function') return null;
  const r = await db.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_KEY]);
  if (!r || !r.rows || !r.rows[0] || !r.rows[0].locked) return { skipped: 'locked' };
  try {
    return await fn();
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
  }
}

/**
 * Одна итерация диспатча. Возвращает { dispatched, errors, skipped }.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=5] — макс. действий за итерацию
 * @param {number} [opts.minPriority=80]
 * @param {boolean} [opts.dryRun=false]
 */
async function runOnce(opts = {}) {
  const limit = Number.isFinite(opts.limit) ? opts.limit : DEFAULT_LIMIT;
  const minPriority = Number.isFinite(opts.minPriority) ? opts.minPriority : 80;
  const dryRun = !!opts.dryRun;

  return await _withLock(async () => {
    const sel = await db.query(
      `SELECT id, site_key, action_key, action_type, target_url, cluster, intent,
              priority, status, payload
         FROM aegis_seo_actions
        WHERE status = 'recommended'
          AND priority >= $1
          AND COALESCE(payload->>'low_risk', 'false') = 'true'
        ORDER BY priority DESC, updated_at ASC
        LIMIT $2`,
      [minPriority, limit],
    );

    const rows = (sel && sel.rows) || [];
    const result = { dispatched: 0, errors: 0, skipped: 0, items: [] };

    for (const action of rows) {
      try {
        if (dryRun) {
          result.skipped += 1;
          result.items.push({ id: action.id, action_key: action.action_key, dry_run: true });
          continue;
        }
        const issue = await githubBot.createIssue({
          title: _renderIssueTitle(action),
          body: _renderIssueBody(action),
          labels: [READY_LABEL],
        });
        const issueNumber = (issue && (issue.number || issue.issueNumber)) || null;
        const mergedPayload = Object.assign({}, action.payload || {}, {
          dispatched_issue: issueNumber,
          dispatched_at: new Date().toISOString(),
        });
        await db.query(
          `UPDATE aegis_seo_actions
              SET status = 'dispatched',
                  payload = $1::jsonb,
                  updated_at = NOW()
            WHERE id = $2`,
          [JSON.stringify(mergedPayload), action.id],
        );
        result.dispatched += 1;
        result.items.push({ id: action.id, action_key: action.action_key, issue_number: issueNumber });
        try {
          const tel = require('./telemetry');
          if (tel && tel.M && tel.M.seoActionsDispatched) tel.M.seoActionsDispatched.inc(1, { outcome: 'ok' });
        } catch (_) { /* graceful */ }
      } catch (err) {
        result.errors += 1;
        result.items.push({ id: action.id, action_key: action.action_key, error: String((err && err.message) || err) });
        try {
          const tel = require('./telemetry');
          if (tel && tel.M && tel.M.seoActionsDispatched) tel.M.seoActionsDispatched.inc(1, { outcome: 'error' });
        } catch (_) { /* graceful */ }
      }
    }
    return result;
  });
}

module.exports = {
  runOnce,
  _renderIssueBody,
  _renderIssueTitle,
};
