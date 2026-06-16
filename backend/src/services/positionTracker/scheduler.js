'use strict';

/**
 * positionTracker/scheduler.js
 *
 * Раз в час просыпается, выбирает проекты с расписанием daily/weekly,
 * у которых last_run_at достаточно стар, и ставит для них новый съём.
 * Поллит без cron-зависимостей (setInterval), gating через
 * POSITION_TRACKER_SCHEDULER_ENABLED=1 (по умолчанию выключен).
 */

const db = require('../../config/db');
const { runPositionRun } = require('./runner');

const TICK_MS = parseInt(process.env.POSITION_TRACKER_TICK_MS, 10) || 60 * 60 * 1000; // 1h
let timer = null;

async function _dueProjects() {
  const { rows } = await db.query(
    `SELECT id, schedule::text AS schedule, last_run_at
       FROM position_projects
      WHERE schedule IN ('daily', 'weekly')
        AND (
          last_run_at IS NULL
          OR (schedule = 'daily'  AND last_run_at < NOW() - INTERVAL '23 hours')
          OR (schedule = 'weekly' AND last_run_at < NOW() - INTERVAL '6 days 23 hours')
        )
      ORDER BY last_run_at NULLS FIRST
      LIMIT 25`,
  );
  return rows;
}

async function tick() {
  try {
    const due = await _dueProjects();
    for (const p of due) {
      try {
        await runPositionRun(p.id);
      } catch (err) {
        console.warn(`[positionTracker.scheduler] project ${p.id} failed:`, err.message);
      }
    }
  } catch (err) {
    console.warn('[positionTracker.scheduler] tick error:', err.message);
  }
}

function startPositionTrackerScheduler() {
  if (process.env.POSITION_TRACKER_SCHEDULER_ENABLED !== '1') {
    console.log('[positionTracker.scheduler] disabled (set POSITION_TRACKER_SCHEDULER_ENABLED=1 to enable)');
    return;
  }
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  // unref на случай тестов и graceful shutdown.
  if (timer.unref) timer.unref();
  console.log(`[positionTracker.scheduler] started (tick=${TICK_MS}ms)`);
  // Один tick через минуту после старта, чтобы не задерживать listen.
  setTimeout(() => { tick().catch(() => {}); }, 60 * 1000).unref?.();
}

function stopPositionTrackerScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  startPositionTrackerScheduler,
  stopPositionTrackerScheduler,
  _tick: tick,
};
