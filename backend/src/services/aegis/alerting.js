'use strict';

/**
 * aegis/alerting — глобальный мониторинг расхода и нотификации.
 *
 * В отличие от budgetGuard (per-task), alerting следит за RATE
 * расхода в целом по системе. Если за rolling-window > rateUsdPerHour,
 * шлётся алерт в Telegram/Slack и (опц.) включается kill switch.
 *
 * Использование:
 *   const alerting = require('./alerting');
 *   alerting.recordSpend({ provider:'deepseek', costUsd:0.012 });
 *   // встроено в orchestrator + recordLlmCall (см. telemetry).
 *
 * Все каналы доставки — ОПЦИОНАЛЬНЫ (graceful). Если ни Telegram,
 * ни Slack не сконфигурированы — алерт логируется в console.warn
 * и в БД (aegis_alerts).
 */

const { getAegisFlags } = require('./featureFlags');
const http  = require('./_httpClient');
const killSwitch = require('./killSwitch');

// ── Rolling window для spend rate ──────────────────────────────────
// Храним массив { ts, costUsd }. При recordSpend выбрасываем ts < cutoff.
const _spend = [];
let _dbRef = null;            // setDbConnection для persist
const _lastAlertAt = new Map(); // alertKey → ts (cooldown)

function setDbConnection(db) { _dbRef = db; }

function _cfg() {
  return getAegisFlags().alerting;
}

function recordSpend({ provider, costUsd } = {}) {
  const c = _cfg();
  if (!c.enabled) return;
  const v = Number(costUsd || 0);
  if (!Number.isFinite(v) || v <= 0) return;
  const now = Date.now();
  _spend.push({ ts: now, provider: String(provider || 'unknown'), costUsd: v });
  _pruneOlderThan(now - c.rollingWindowSec * 1000);
  _checkRate(now).catch(() => {});
}

function _pruneOlderThan(cutoffMs) {
  while (_spend.length && _spend[0].ts < cutoffMs) _spend.shift();
}

function getCurrentRate() {
  const c = _cfg();
  const cutoff = Date.now() - c.rollingWindowSec * 1000;
  _pruneOlderThan(cutoff);
  let total = 0;
  for (const e of _spend) total += e.costUsd;
  const windowHours = c.rollingWindowSec / 3600;
  return {
    window_sec:   c.rollingWindowSec,
    total_usd:    Math.round(total * 1e6) / 1e6,
    rate_usd_h:   Math.round((total / Math.max(windowHours, 1e-9)) * 1000) / 1000,
    samples:      _spend.length,
    threshold_usd_h: c.rateUsdPerHour,
  };
}

async function _checkRate(now) {
  const c = _cfg();
  const stats = getCurrentRate();
  if (stats.rate_usd_h <= c.rateUsdPerHour) return;

  // Cooldown — не флудить.
  const alertKey = 'spend_rate_breach';
  const lastTs = _lastAlertAt.get(alertKey) || 0;
  if (now - lastTs < c.cooldownSec * 1000) return;
  _lastAlertAt.set(alertKey, now);

  const msg = `🚨 [A.E.G.I.S.] Spend-rate breach: ${stats.rate_usd_h} USD/h `
    + `(window ${c.rollingWindowSec}s, limit ${c.rateUsdPerHour} USD/h, samples ${stats.samples})`;
  await sendAlert({ severity: 'critical', message: msg, payload: stats });

  // Auto-kill switch (если включено).
  if (c.autoKillOnBreach && !killSwitch.isEngaged()) {
    await killSwitch.engage({
      reason: `auto: spend rate ${stats.rate_usd_h} > ${c.rateUsdPerHour} USD/h`,
      setBy:  'alerting',
      db:     _dbRef,
    });
    await sendAlert({
      severity: 'critical',
      message:  '🛑 [A.E.G.I.S.] Kill switch ENGAGED automatically due to spend-rate breach.',
      payload:  stats,
    });
  }
}

/**
 * sendAlert({ severity, message, payload }) — отправить alert во все каналы.
 * Возвращает массив доставок (по одной на канал).
 */
async function sendAlert({ severity = 'warning', message, payload = null } = {}) {
  const c = _cfg();
  const deliveries = [];

  // Telegram
  if (c.telegramBotToken && c.telegramChatId) {
    try {
      const tgUrl = `https://api.telegram.org/bot${c.telegramBotToken}/sendMessage`;
      const r = await http.post(tgUrl, '', {
        chat_id: c.telegramChatId,
        text:    `[${severity.toUpperCase()}] ${message}`,
        disable_web_page_preview: true,
      }, { timeoutMs: 5000 });
      deliveries.push({ channel: 'telegram', ok: r.ok, status: r.status });
    } catch (e) { deliveries.push({ channel: 'telegram', ok: false, error: e.message }); }
  }

  // Slack
  if (c.slackWebhookUrl) {
    try {
      const r = await http.post(c.slackWebhookUrl, '', {
        text: `*[${severity.toUpperCase()}]* ${message}`,
      }, { timeoutMs: 5000 });
      deliveries.push({ channel: 'slack', ok: r.ok, status: r.status });
    } catch (e) { deliveries.push({ channel: 'slack', ok: false, error: e.message }); }
  }

  // Fallback: console + DB.
  if (!deliveries.length) {
    console.warn(`[aegis/alerting] ${message}`);
  }
  if (_dbRef) {
    try {
      await _dbRef.query(
        `INSERT INTO aegis_alerts (severity, message, payload, deliveries)
         VALUES ($1, $2, $3, $4)`,
        [severity, message, payload ? JSON.stringify(payload) : null,
         JSON.stringify(deliveries)],
      );
    } catch (_e) { /* table may not exist yet */ }
  }
  return deliveries;
}

function _resetForTests() {
  _spend.length = 0;
  _lastAlertAt.clear();
}

module.exports = {
  setDbConnection,
  recordSpend,
  getCurrentRate,
  sendAlert,
  _resetForTests,
};
