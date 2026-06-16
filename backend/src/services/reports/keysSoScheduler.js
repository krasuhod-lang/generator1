'use strict';

/**
 * reports/keysSoScheduler.js — суточный CRON-цикл синхронизации Keys.so.
 *
 * Запускается из server.js при старте процесса (gated по KEYS_SO_API_KEY:
 * без ключа просто не стартует). Ничего не делает на прод-репликах, у которых
 * REPORTS_KEYS_SO_SYNC=disabled.
 *
 * Интервал по умолчанию — 24 часа; при старте прогоняется первая итерация
 * через 60 секунд, чтобы не задерживать boot.
 */

const { syncAllDomains } = require('./keysSoSync');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
let _timer = null;
let _kickoff = null;

function startKeysSoScheduler() {
  if (_timer) return;
  if (process.env.REPORTS_KEYS_SO_SYNC === 'disabled') {
    console.log('[KeysSoScheduler] disabled via REPORTS_KEYS_SO_SYNC=disabled');
    return;
  }
  if (!process.env.KEYS_SO_API_KEY) {
    console.log('[KeysSoScheduler] skipped: no KEYS_SO_API_KEY');
    return;
  }
  const interval = Number(process.env.REPORTS_KEYS_SO_SYNC_INTERVAL_MS) || DEFAULT_INTERVAL_MS;
  const tick = async () => {
    try {
      const res = await syncAllDomains({ months: 12 });
      console.log(`[KeysSoScheduler] tick processed=${res.processed} skipped=${res.skipped} errors=${res.errors.length}`);
    } catch (err) {
      console.warn('[KeysSoScheduler] tick failed:', err.message);
    }
  };
  _kickoff = setTimeout(tick, 60_000);
  _timer = setInterval(tick, interval);
  console.log(`[KeysSoScheduler] started (interval ${interval} ms)`);
}

function stopKeysSoScheduler() {
  if (_timer) clearInterval(_timer);
  if (_kickoff) clearTimeout(_kickoff);
  _timer = null;
  _kickoff = null;
}

module.exports = { startKeysSoScheduler, stopKeysSoScheduler };
