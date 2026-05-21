'use strict';

/**
 * controllers/aegis — публичный API мозга A.E.G.I.S.
 *
 * GET  /api/aegis/status        — сводка: флаги, brain state, health подсистем.
 * GET  /api/aegis/backlog       — список GitHub-issues с label aegis:ready.
 * POST /api/aegis/backlog       — создать issue (опц., только admin).
 * POST /api/aegis/dspy/retrain  — триггер weekly retrain (admin).
 * POST /api/aegis/mutate/propose — попросить deepseek-mutator предложить патч (admin).
 * GET  /api/aegis/runs          — последние aegis_runs (читает таблицу).
 * GET  /api/aegis/brain/versions — история brain_versions (миграция 042).
 *
 * Все mutation-endpoints — admin-only. Read endpoints — auth.
 */

const db   = require('../config/db');
const { getAegisFlags }  = require('../services/aegis/featureFlags');
const { getBrainSummary } = require('../services/aegis/brainStateRegistry');
const graphrag = require('../services/aegis/graphragClient');
const vectordb = require('../services/aegis/vectordbClient');
const ray      = require('../services/aegis/rayClient');
const dspy     = require('../services/aegis/dspyClient');
const githubBot = require('../services/aegis/githubBot');
const mutator  = require('../services/aegis/deepseekMutator');
const telemetry  = require('../services/aegis/telemetry');
const alerting   = require('../services/aegis/alerting');
const killSwitch = require('../services/aegis/killSwitch');
const llmRouter  = require('../services/aegis/llmRouter');
const backup     = require('../services/aegis/backupClient');

/** GET /api/aegis/status */
async function getStatus(req, res) {
  const flags = getAegisFlags();
  const brain = getBrainSummary();
  const [grHealth, vdHealth, rayHealth, dspyStatus] = await Promise.all([
    graphrag.health(),
    vectordb.health(),
    ray.health(),
    dspy.status(),
  ]);
  res.json({
    enabled: flags.enabled,
    quality_gate: {
      min_overall: flags.qualityGate.minOverall,
      min_sub:     flags.qualityGate.minSub,
      on_fail:     flags.qualityGate.onFail,
    },
    shannon:    { enabled: flags.shannon.enabled, min_h: flags.shannon.minEntropy },
    graphrag:   { enabled: flags.graphrag.enabled, health: grHealth },
    vectordb:   { enabled: flags.vectordb.enabled, health: vdHealth },
    ray:        { enabled: flags.ray.enabled,      health: rayHealth },
    langgraph:  { enabled: flags.langgraph.enabled, max_refine: flags.langgraph.maxRefineIters },
    dspy:       { enabled: flags.dspy.enabled,      status: dspyStatus },
    rl_ga4:     { enabled: flags.rlGa4.enabled,     property_id_set: Boolean(flags.rlGa4.propertyId) },
    selfmutate: {
      enabled: flags.selfmutate.enabled,
      require_human_review: flags.selfmutate.requireHumanReview,
    },
    backlog: {
      enabled: flags.backlog.enabled,
      repo_set: Boolean(flags.backlog.repo),
    },
    brain_state: brain,
  });
}

/** GET /api/aegis/backlog */
async function listBacklog(req, res) {
  const flags = getAegisFlags().backlog;
  const label = req.query.label || flags.issueLabel;
  const r = await githubBot.listIssues({ label, state: req.query.state || 'open' });
  if (!r.ok) return res.status(503).json({ error: 'github_unavailable', reason: r.reason });
  res.json({ items: r.items });
}

/** POST /api/aegis/backlog (admin) */
async function createBacklogItem(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { title, body, labels = [] } = req.body || {};
  if (typeof title !== 'string' || title.length < 3 || title.length > 200) {
    return res.status(400).json({ error: 'invalid_title' });
  }
  const flags = getAegisFlags().backlog;
  const mergedLabels = Array.from(new Set([flags.issueLabel, 'aegis', ...(Array.isArray(labels) ? labels : [])]));
  const r = await githubBot.createIssue({ title, body: body || '', labels: mergedLabels });
  if (!r.ok) return res.status(503).json({ error: 'github_unavailable', reason: r.reason });
  // Записываем в aegis_backlog.
  try {
    await db.query(
      `INSERT INTO aegis_backlog (issue_number, title, labels, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (issue_number) DO NOTHING`,
      [r.number, title, JSON.stringify(mergedLabels)],
    );
  } catch (e) {
    // не критично — backlog таблица может быть ещё не накатана.
  }
  res.json({ number: r.number, url: r.url });
}

/** POST /api/aegis/dspy/retrain (admin) */
async function triggerDspyRetrain(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { niche = null, dry_run = false } = req.body || {};
  const r = await dspy.retrain({ niche, dryRun: Boolean(dry_run) });
  if (!r.ok) return res.status(503).json({ error: 'dspy_unavailable', reason: r.reason });
  res.json({ ok: true, body: r.body });
}

/** POST /api/aegis/mutate/propose (admin) */
async function proposeMutation(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { filePath, oldCode, errorContext, domSnippet } = req.body || {};
  if (typeof filePath !== 'string' || typeof oldCode !== 'string') {
    return res.status(400).json({ error: 'invalid_input' });
  }
  const r = await mutator.proposePatch({ filePath, oldCode, errorContext, domSnippet });
  if (!r.ok) return res.status(503).json({ error: 'mutator_failed', reason: r.reason });
  // Логируем попытку.
  try {
    await db.query(
      `INSERT INTO aegis_mutations (file_path, abort, abort_reason, diff_text, tokens_cost_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [filePath, !!r.abort, r.abortReason || null, r.diff || null, r.cost_usd || null],
    );
  } catch (e) { /* table may not exist yet */ }
  res.json(r);
}

/** GET /api/aegis/runs */
async function listRuns(req, res) {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  try {
    const r = await db.query(
      `SELECT id, kind, status, overall_score, iterations, cost_usd, created_at, finished_at
         FROM aegis_runs
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    );
    res.json({ items: r.rows });
  } catch (e) {
    res.json({ items: [], warning: e.message });
  }
}

/** GET /api/aegis/brain/versions */
async function listBrainVersions(req, res) {
  try {
    const r = await db.query(
      `SELECT id, yaml_path, sha, mean_spq_before, mean_spq_after, deployed_at
         FROM aegis_brain_versions
        ORDER BY deployed_at DESC
        LIMIT 50`,
    );
    res.json({ items: r.rows, current: getBrainSummary() });
  } catch (e) {
    res.json({ items: [], current: getBrainSummary(), warning: e.message });
  }
}

module.exports = {
  getStatus,
  listBacklog,
  createBacklogItem,
  triggerDspyRetrain,
  proposeMutation,
  listRuns,
  listBrainVersions,
  // Phase 9–13:
  getMetrics,
  getKillSwitch,
  postKillSwitch,
  getSpendRate,
  getRouterBreakers,
  runBackupNow,
  listBackups,
};

// ─────────────────────────── Phase 9–13 ────────────────────────────

/** GET /api/aegis/metrics — Prometheus exposition (text/plain). */
function getMetrics(req, res) {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  // Подмешиваем kill switch и spend rate в gauges перед экспортом.
  try {
    telemetry.M.killswitch.set(killSwitch.isEngaged() ? 1 : 0);
    const stats = alerting.getCurrentRate();
    telemetry.M.budgetUsd.inc(0, { kind: 'noop' }); // ensure counter is registered
    // Дополнительный гейдж — на лету.
    telemetry.gauge('aegis_spend_rate_usd_per_hour', 'Rolling spend rate USD/h').set(stats.rate_usd_h);
  } catch (_e) { /* keep response */ }
  res.send(telemetry.toPrometheus());
}

/** GET /api/aegis/kill */
function getKillSwitch(req, res) {
  res.json({
    ...killSwitch.snapshot(),
    spend_rate: alerting.getCurrentRate(),
    breakers:   llmRouter.getBreakerStates(),
  });
}

/** POST /api/aegis/kill (admin) — body: { action:'engage'|'disengage', reason } */
async function postKillSwitch(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { action, reason } = req.body || {};
  if (action !== 'engage' && action !== 'disengage') {
    return res.status(400).json({ error: 'invalid_action', allowed: ['engage', 'disengage'] });
  }
  const setBy = req.user.email || req.user.id || 'admin';
  let snap;
  if (action === 'engage') {
    snap = await killSwitch.engage({ reason: reason || 'manual', setBy, db });
    await alerting.sendAlert({
      severity: 'critical',
      message:  `🛑 [A.E.G.I.S.] Kill switch ENGAGED manually by ${setBy}: ${reason || ''}`,
    });
  } else {
    snap = await killSwitch.disengage({ setBy, db });
    await alerting.sendAlert({
      severity: 'info',
      message:  `✅ [A.E.G.I.S.] Kill switch DISENGAGED by ${setBy}`,
    });
  }
  res.json(snap);
}

/** GET /api/aegis/finops/spend */
function getSpendRate(req, res) {
  res.json(alerting.getCurrentRate());
}

/** GET /api/aegis/router/breakers */
function getRouterBreakers(req, res) {
  res.json({ breakers: llmRouter.getBreakerStates() });
}

/** POST /api/aegis/backup/run (admin) */
async function runBackupNow(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { targets } = req.body || {};
  const r = await backup.runBackup({ targets });
  if (!r.ok && r.reason === 'disabled') return res.status(409).json({ error: 'backup_disabled' });
  if (!r.ok) return res.status(503).json({ error: 'backup_failed', reason: r.reason });
  // Persist в aegis_backups.
  try {
    await db.query(
      `INSERT INTO aegis_backups (status, targets, result, s3_bucket)
       VALUES ($1, $2, $3, $4)`,
      ['ok', JSON.stringify(targets || []), JSON.stringify(r.body || {}), getAegisFlags().backup.s3Bucket || null],
    );
  } catch (_e) { /* may not exist */ }
  res.json({ ok: true, body: r.body });
}

/** GET /api/aegis/backup/list */
async function listBackups(req, res) {
  const r = await backup.listBackups();
  if (!r.ok) return res.status(503).json({ error: 'backup_list_failed', reason: r.reason });
  res.json(r.body || { items: [] });
}
