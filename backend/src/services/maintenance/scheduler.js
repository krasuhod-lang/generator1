'use strict';

/**
 * maintenance/scheduler — суточный планировщик ретеншена хранилища.
 *
 * По аналогии с positionTracker/scheduler и outreachScheduler: поллит без
 * cron-зависимостей (setInterval) и раз в сутки, в ночное окно, запускает
 * runStorageRetention. Kill-switch — STORAGE_RETENTION_ENABLED=1 (по умолчанию
 * выключен, чтобы не удалять данные без явного включения на проде).
 *
 * ENV:
 *   STORAGE_RETENTION_ENABLED    = 1|0    — включить планировщик (default off)
 *   STORAGE_RETENTION_TICK_MS    = 3600000 — период поллинга (default 1h)
 *   STORAGE_RETENTION_HOUR       = 4      — час запуска (локальный), default 4:00
 */

const { runStorageRetention } = require('./storageRetention');

const TICK_MS = parseInt(process.env.STORAGE_RETENTION_TICK_MS, 10) || 60 * 60 * 1000; // 1h
let timer = null;
let lastRunDay = null; // 'YYYY-MM-DD' последнего успешного запуска — не чаще раза в сутки.

function _runHour() {
  const h = parseInt(process.env.STORAGE_RETENTION_HOUR, 10);
  if (!Number.isFinite(h) || h < 0 || h > 23) return 4;
  return h;
}

function _dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * tick — если наступил час запуска и сегодня ещё не запускались — гоняем прогон.
 */
async function tick(now = new Date()) {
  try {
    const day = _dayKey(now);
    if (lastRunDay === day) return;            // уже отработали сегодня
    if (now.getHours() < _runHour()) return;   // ещё не наступило окно
    lastRunDay = day;
    await runStorageRetention();
  } catch (err) {
    console.warn('[storageRetention.scheduler] tick error:', err.message);
  }
}

function startStorageRetentionScheduler() {
  if (process.env.STORAGE_RETENTION_ENABLED !== '1') {
    console.log('[storageRetention.scheduler] disabled (set STORAGE_RETENTION_ENABLED=1 to enable)');
    return;
  }
  if (timer) return;
  timer = setInterval(() => { tick().catch(() => {}); }, TICK_MS);
  if (timer.unref) timer.unref();
  console.log(`[storageRetention.scheduler] started (tick=${TICK_MS}ms, hour=${_runHour()}:00)`);
  // Первый tick через минуту после старта, чтобы не задерживать listen.
  setTimeout(() => { tick().catch(() => {}); }, 60 * 1000).unref?.();
}

function stopStorageRetentionScheduler() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = {
  startStorageRetentionScheduler,
  stopStorageRetentionScheduler,
  _tick: tick,
};
