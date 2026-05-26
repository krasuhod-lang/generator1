'use strict';

/**
 * aegis/seoBrainScheduler — суточный автозапуск seoBrain.analyze.
 *
 * Зачем: чтобы карточка «🧠 SEO Brain» в /aegis перестала висеть в
 * «snapshot ещё не построен», когда воркер aegis_seo_observations уже
 * пишет наблюдения. Раз в autoAnalyzeIntervalSec проверяем все site_key,
 * по которым были наблюдения за последние autoAnalyzeLookbackDays, и
 * собираем по ним свежий snapshot, если с предыдущего успешного прошло
 * ≥ autoAnalyzeMinSpacingSec.
 *
 * Никаких сетевых вызовов и LLM — данные берутся из aegis_seo_observations.
 */

const db = require('../../config/db');
const seoBrain = require('./seoBrain');
const { getAegisFlags } = require('./featureFlags');

let _timer = null;
let _running = false;

const _telemetry = {
  last_check_at:        null,
  last_run_at:          null,
  last_sites_processed: null,
  last_error:           null,
  next_run_eta_sec:     null,
};

function getSeoBrainSchedulerTelemetry() {
  return { ..._telemetry };
}

async function _listSiteKeys(lookbackDays) {
  try {
    const r = await db.query(
      `SELECT DISTINCT site_key
         FROM aegis_seo_observations
        WHERE observed_at > NOW() - ($1::int || ' days')::interval
        LIMIT 50`,
      [Math.max(1, Number(lookbackDays) || 30)]
    );
    return r.rows.map(r => r.site_key).filter(Boolean);
  } catch (_) { return []; }
}

async function _lastSnapshotAge(siteKey) {
  try {
    const r = await db.query(
      `SELECT created_at FROM aegis_seo_memory
        WHERE site_key = $1 ORDER BY created_at DESC LIMIT 1`,
      [siteKey]
    );
    if (!r.rows.length) return null;
    return (Date.now() - new Date(r.rows[0].created_at).getTime()) / 1000;
  } catch (_) { return null; }
}

async function _loadPagesForSite(siteKey, lookbackDays, maxPages) {
  try {
    const r = await db.query(
      `SELECT url,
              MAX(observed_at)   AS observed_at,
              SUM(clicks)        AS clicks,
              SUM(impressions)   AS impressions,
              AVG(ctr)           AS ctr,
              AVG(position)      AS position,
              SUM(sessions)      AS sessions,
              AVG(engagement_rate) AS engagement_rate
         FROM aegis_seo_observations
        WHERE site_key = $1
          AND observed_at > NOW() - ($2::int || ' days')::interval
        GROUP BY url
        ORDER BY MAX(observed_at) DESC
        LIMIT $3`,
      [siteKey, Math.max(1, Number(lookbackDays) || 30), Math.max(1, Number(maxPages) || 200)]
    );
    return r.rows.map((row) => ({
      url: row.url,
      clicks: Number(row.clicks) || 0,
      impressions: Number(row.impressions) || 0,
      ctr: Number(row.ctr) || 0,
      position: Number(row.position) || 0,
      sessions: Number(row.sessions) || 0,
      engagement_rate: Number(row.engagement_rate) || 0,
      last_observed_at: row.observed_at,
    }));
  } catch (_) { return []; }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const flags = getAegisFlags().seoBrain || {};
    _telemetry.last_check_at = new Date().toISOString();

    if (!flags.enabled || !flags.autoAnalyzeEnabled) {
      _telemetry.last_error = 'auto_disabled';
      return;
    }

    const lookback = Number(flags.autoAnalyzeLookbackDays) || 30;
    const minSpacing = Number(flags.autoAnalyzeMinSpacingSec) || 79200;
    const maxPages = Number(flags.autoAnalyzeMaxPagesPerSite) || 200;

    const siteKeys = await _listSiteKeys(lookback);
    if (!siteKeys.length) {
      _telemetry.last_error = 'no_observations';
      return;
    }

    let processed = 0;
    for (const siteKey of siteKeys) {
      const ageSec = await _lastSnapshotAge(siteKey);
      if (ageSec !== null && ageSec < minSpacing) continue;

      const pages = await _loadPagesForSite(siteKey, lookback, maxPages);
      if (!pages.length) continue;

      try {
        const snapshot = seoBrain.buildSeoBrainSnapshot({
          site: { site_key: siteKey, site_url: '' },
          pages,
          signals: {},
          autonomyStage: flags.defaultAutonomyStage || 'recommend',
        });
        await seoBrain.persistSnapshot(db, snapshot);
        processed += 1;
      } catch (e) {
        console.warn(`[aegis/seoBrainScheduler] site=${siteKey} failed:`, e.message);
      }
    }

    _telemetry.last_run_at = new Date().toISOString();
    _telemetry.last_sites_processed = processed;
    _telemetry.last_error = null;
    _telemetry.next_run_eta_sec = Number(flags.autoAnalyzeIntervalSec) || 86400;
  } catch (e) {
    _telemetry.last_error = e.message;
    console.warn('[aegis/seoBrainScheduler] tick failed:', e.message);
  } finally {
    _running = false;
  }
}

function startSeoBrainScheduler() {
  if (_timer) return;
  const flags = getAegisFlags().seoBrain || {};
  const intervalSec = Number(flags.autoAnalyzeIntervalSec) || 86400;
  _timer = setInterval(() => {
    tick().catch((e) => console.warn('[aegis/seoBrainScheduler] interval:', e.message));
  }, intervalSec * 1000);
  _timer.unref?.();
  setTimeout(() => tick().catch(() => {}), 30_000).unref?.();
}

function stopSeoBrainScheduler() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { startSeoBrainScheduler, stopSeoBrainScheduler, tick, getSeoBrainSchedulerTelemetry };
