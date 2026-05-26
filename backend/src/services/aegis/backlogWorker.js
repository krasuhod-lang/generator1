'use strict';

const db = require('../../config/db');
const githubBot = require('./githubBot');
const { getAegisFlags } = require('./featureFlags');
const { parseIssueToTask } = require('./backlogParser');
const { dispatchBacklogItem } = require('./backlogDispatcher');
const { markIssueInProgress, finalizeBacklogIssue } = require('./backlogHooks');

const POLL_MS = 60_000;
const LOCK_KEY = 9_014_001;

let _timer = null;
let _running = false;

// Telemetry для /api/aegis/status → блок backlog.
// Помогает отличить «бэклог пуст» от «воркер не запускался / GitHub недоступен».
const _telemetry = {
  last_poll_at:     null,
  last_poll_found:  null,  // сколько open issues с label=aegis:ready вернул GitHub
  last_poll_dispatched: null,
  repo_reachable:   null,  // true/false по результату listIssues
  last_error:       null,
};

function getBacklogTelemetry() {
  return { ..._telemetry };
}

function _hasLabel(issue, name) {
  const labels = Array.isArray(issue && issue.labels) ? issue.labels : [];
  return labels.some((l) => String((l && l.name) || '').toLowerCase() === String(name || '').toLowerCase());
}

async function _acquireLock() {
  const { rows } = await db.query(`SELECT pg_try_advisory_lock($1) AS ok`, [LOCK_KEY]);
  return Boolean(rows[0] && rows[0].ok);
}

async function _releaseLock() {
  try { await db.query(`SELECT pg_advisory_unlock($1)`, [LOCK_KEY]); } catch (_) { /* no-op */ }
}

async function runTick() {
  if (_running) return;
  _running = true;
  const flags = getAegisFlags().backlog;
  if (!flags.enabled) {
    _running = false;
    return;
  }

  let locked = false;
  try {
    locked = await _acquireLock();
    if (!locked) return;

    const r = await githubBot.listIssues({
      label: flags.issueLabel,
      state: 'open',
      per_page: 30,
    });
    _telemetry.last_poll_at = new Date().toISOString();
    _telemetry.repo_reachable = Boolean(r && r.ok);
    if (!r.ok) {
      _telemetry.last_error = String((r && r.reason) || 'listIssues_failed');
      return;
    }
    _telemetry.last_error = null;
    _telemetry.last_poll_found = Array.isArray(r.items) ? r.items.length : 0;
    let dispatchedCount = 0;

    for (const issue of (r.items || [])) {
      if (_hasLabel(issue, 'aegis:in-progress') || _hasLabel(issue, 'aegis:done') || _hasLabel(issue, 'aegis:failed')) {
        continue;
      }

      const issueNumber = Number(issue.number) || null;
      if (!issueNumber) continue;

      await markIssueInProgress(issueNumber);

      const parsed = parseIssueToTask(issue);
      const dispatched = await dispatchBacklogItem({
        kind: parsed.kind,
        payload: parsed.payload,
        issueNumber,
        issueTitle: issue.title,
      });
      if (dispatched.ok) dispatchedCount += 1;

      if (!dispatched.ok) {
        await finalizeBacklogIssue({
          issueNumber,
          ok: false,
          status: 'failed',
          taskRef: null,
          taskKind: parsed.kind,
          error: String(dispatched.reason || 'dispatch_failed'),
          comment: `❌ AEGIS dispatch failed: ${String(dispatched.reason || 'dispatch_failed')}`,
        });
      }
    }
    _telemetry.last_poll_dispatched = dispatchedCount;
  } catch (e) {
    _telemetry.last_error = e.message;
    console.warn('[aegis/backlogWorker] tick failed:', e.message);
  } finally {
    if (locked) await _releaseLock();
    _running = false;
  }
}

function startBacklogWorker() {
  if (_timer) return;
  _timer = setInterval(() => {
    runTick().catch((e) => console.warn('[aegis/backlogWorker] interval:', e.message));
  }, POLL_MS);
  _timer.unref?.();
  runTick().catch((e) => console.warn('[aegis/backlogWorker] first tick:', e.message));
}

function stopBacklogWorker() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { startBacklogWorker, stopBacklogWorker, runTick, getBacklogTelemetry };
