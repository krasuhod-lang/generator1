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
const vectorGc   = require('../services/aegis/vectorGc');
const biobrain   = require('../services/aegis/biobrainClient');
const promptAudit = require('../services/aegis/promptAudit');
const { LABEL_READY, LABEL_IN_PROGRESS, LABEL_DONE, LABEL_FAILED } = require('../services/aegis/backlogHooks');

/** GET /api/aegis/status */
async function getStatus(req, res) {
  const flags = getAegisFlags();
  const brain = getBrainSummary();
  let datasetStats = { total_rows: 0, rows_24h: 0, avg_spq: null, niches_coverage_pct: null };
  try {
    const [{ rows: totalRows }, { rows: withNicheRows }] = await Promise.all([
      db.query(
        `SELECT COUNT(*)::int AS total_rows,
                COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS rows_24h,
                AVG(spq_overall)::numeric(10,2) AS avg_spq
           FROM aegis_dspy_dataset
          WHERE is_seed = FALSE`,
      ),
      db.query(
        `SELECT
           COUNT(*) FILTER (WHERE COALESCE(niche, '') <> '')::int AS with_niche,
           COUNT(*)::int AS total
         FROM aegis_dspy_dataset
         WHERE is_seed = FALSE`,
      ),
    ]);
    const t = totalRows[0] || {};
    const n = withNicheRows[0] || {};
    datasetStats = {
      total_rows: Number(t.total_rows) || 0,
      rows_24h: Number(t.rows_24h) || 0,
      avg_spq: t.avg_spq == null ? null : Number(t.avg_spq),
      niches_coverage_pct: (Number(n.total) || 0) > 0
        ? Math.round(((Number(n.with_niche) || 0) * 1000) / Number(n.total)) / 10
        : null,
    };
  } catch (_) { /* optional */ }
  const [grHealth, vdHealth, rayHealth, dspyStatus, biobrainStatus] = await Promise.all([
    graphrag.health(),
    vectordb.health(),
    ray.health(),
    dspy.status(),
    biobrain.status().catch(() => ({ ok: false, reason: 'unavailable' })),
  ]);
  let promptStats;
  let promptLinkage;
  try {
    await promptAudit.persistCurrentPrompts(db);
  } catch (_) { /* optional audit table */ }
  try {
    [promptStats, promptLinkage] = await Promise.all([
      promptAudit.getPromptDashboardStats(db),
      promptAudit.getPromptDspyLinkageStats(db),
    ]);
  } catch (_) {
    promptStats = { total_prompts: 0, dspy_linked: 0, recent_changes: [] };
    promptLinkage = {};
  }
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
    biobrain: {
      enabled: Boolean(flags.biobrain && flags.biobrain.enabled),
      status: biobrainStatus && biobrainStatus.body ? biobrainStatus.body : null,
    },
    prompt_audit: promptStats,
    prompt_dspy_linkage: promptLinkage,
    autonomy: promptAudit.buildAutonomySnapshot(flags),
    site_opportunities: promptAudit.buildSiteOpportunities(),
    training_dataset: datasetStats,
    brain_state: brain,
  });
}

/** GET /api/aegis/backlog */
async function listBacklog(req, res) {
  const flags = getAegisFlags().backlog;
  const label = req.query.label || flags.issueLabel;
  const r = await githubBot.listIssues({ label, state: req.query.state || 'open' });
  if (!r.ok && r.reason !== 'not_configured') {
    return res.status(503).json({ error: 'github_unavailable', reason: r.reason });
  }
  if (!r.ok && r.reason === 'not_configured') {
    try {
      const local = await db.query(
        `SELECT issue_number AS number, title,
                status AS local_status, task_ref, task_kind,
                spq_overall, error AS local_error, finished_at
           FROM aegis_backlog
          ORDER BY updated_at DESC
          LIMIT 100`,
      );
      return res.json({ items: local.rows });
    } catch (_) {
      return res.json({ items: [] });
    }
  }
  const numbers = (r.items || []).map((i) => Number(i.number)).filter((n) => Number.isFinite(n));
  let byNum = new Map();
  if (numbers.length) {
    try {
      const local = await db.query(
        `SELECT issue_number, status, task_ref, task_kind, spq_overall, error, finished_at
           FROM aegis_backlog
          WHERE issue_number = ANY($1::int[])`,
        [numbers],
      );
      byNum = new Map(local.rows.map((x) => [Number(x.issue_number), x]));
    } catch (_) { /* ignore */ }
  }
  const items = (r.items || []).map((i) => {
    const local = byNum.get(Number(i.number)) || {};
    return {
      ...i,
      local_status: local.status || 'pending',
      task_ref: local.task_ref || null,
      task_kind: local.task_kind || null,
      spq_overall: local.spq_overall == null ? null : Number(local.spq_overall),
      local_error: local.error || null,
      finished_at: local.finished_at || null,
    };
  });
  res.json({ items });
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

/** POST /api/aegis/backlog/:number/retry (admin) */
async function retryBacklogItem(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const issueNumber = parseInt(req.params.number, 10);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) return res.status(400).json({ error: 'invalid_issue_number' });

  await githubBot.removeLabel({ issueNumber, label: LABEL_DONE });
  await githubBot.removeLabel({ issueNumber, label: LABEL_FAILED });
  await githubBot.removeLabel({ issueNumber, label: LABEL_IN_PROGRESS });
  await githubBot.addLabel({ issueNumber, label: LABEL_READY });

  try {
    await db.query(
      `INSERT INTO aegis_backlog (issue_number, title, labels, status, error, finished_at, updated_at)
       VALUES ($1, '', '[]'::jsonb, 'pending', NULL, NULL, NOW())
       ON CONFLICT (issue_number)
       DO UPDATE SET status='pending', error=NULL, finished_at=NULL, updated_at=NOW()`,
      [issueNumber],
    );
  } catch (_) { /* ignore */ }

  res.json({ ok: true, issue_number: issueNumber });
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
      `SELECT id, yaml_path, sha, mean_spq_before, mean_spq_after,
              improvement_pct, trials_done, dataset_size, cost_usd, deployed_at
         FROM aegis_brain_versions
        ORDER BY deployed_at DESC
        LIMIT 50`,
    );
    res.json({ items: r.rows, current: getBrainSummary() });
  } catch (e) {
    res.json({ items: [], current: getBrainSummary(), warning: e.message });
  }
}

/** GET /api/aegis/prompts/log — история изменения Prompts-as-Code. */
async function listPromptAuditLog(req, res) {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 30));
  try {
    await promptAudit.persistCurrentPrompts(db).catch(() => {});
    const r = await db.query(
      `SELECT id, prompt_key, source_path, prompt_hash, previous_hash,
              change_kind, role, dspy_linked, content_chars, vars,
              active, first_seen_at, last_seen_at, changed_at
         FROM aegis_prompt_audit
        ORDER BY changed_at DESC, id DESC
        LIMIT $1`,
      [limit],
    );
    res.json({
      items: r.rows.map((x) => ({
        ...x,
        hash_short: String(x.prompt_hash || '').slice(0, 12),
        previous_hash_short: String(x.previous_hash || '').slice(0, 12) || null,
      })),
    });
  } catch (e) {
    res.json({ items: [], warning: e.message });
  }
}

module.exports = {
  getStatus,
  listBacklog,
  createBacklogItem,
  retryBacklogItem,
  triggerDspyRetrain,
  proposeMutation,
  listRuns,
  listBrainVersions,
  listPromptAuditLog,
  // Phase 9–13:
  getMetrics,
  getKillSwitch,
  postKillSwitch,
  getSpendRate,
  getRouterBreakers,
  runBackupNow,
  listBackups,
  // Phase 14:
  runVectorGcSweep,
  runVectorGcCleanup,
};

/** GET /api/aegis/quality-log — последние N записей теневого датасета. */
async function listQualityLog(req, res) {
  const flags = getAegisFlags().qualityLog || {};
  const dflt = Number(flags.listDefaultLimit) || 30;
  const max  = Number(flags.listMaxLimit)     || 200;
  const limit = Math.min(max, Math.max(1, parseInt(req.query.limit, 10) || dflt));
  const kind  = (req.query.kind && String(req.query.kind).slice(0, 32)) || null;
  try {
    const args = [limit];
    let where = '';
    if (kind) { args.push(kind); where = `WHERE kind = $2`; }
    const r = await db.query(
      `SELECT id, article_ref, kind, niche, spq_overall, sub, verdict_summary,
              failure_reasons, top_failure_layer, status, passes_gate,
              model_used, cost_usd, iterations, prompt_hash, prompt_meta, created_at
         FROM aegis_quality_log
         ${where}
        ORDER BY created_at DESC
        LIMIT $1`,
      args,
    );
    res.json({ items: r.rows });
  } catch (e) {
    res.json({ items: [], warning: e.message });
  }
}

/** GET /api/aegis/failures/top?days=7 — агрегация симптомов за окно. */
async function listTopFailures(req, res) {
  const flags = getAegisFlags().qualityLog || {};
  const dflt = Number(flags.topFailuresDefaultDays) || 7;
  const max  = Number(flags.topFailuresMaxDays)     || 90;
  const days = Math.min(max, Math.max(1, parseInt(req.query.days, 10) || dflt));
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10)
    || Number(flags.topFailuresLimit) || 15));

  try {
    // jsonb_array_elements_text разворачивает failure_reasons в строки;
    // окно `days` фиксировано параметром $1, чтобы не было SQL-injection.
    const r = await db.query(
      `WITH expanded AS (
         SELECT
           jsonb_array_elements_text(failure_reasons) AS symptom,
           created_at,
           article_ref,
           kind,
           niche,
           spq_overall
         FROM aegis_quality_log
         WHERE created_at > NOW() - ($1::int || ' days')::interval
       )
       SELECT
         symptom,
         COUNT(*)::int                       AS frequency,
         COUNT(DISTINCT niche) FILTER (WHERE niche IS NOT NULL)::int AS niches,
         MAX(created_at)                     AS last_seen_at,
         (ARRAY_AGG(article_ref ORDER BY created_at DESC))[1] AS last_article_ref,
         (ARRAY_AGG(kind        ORDER BY created_at DESC))[1] AS last_kind,
         (ARRAY_AGG(niche       ORDER BY created_at DESC))[1] AS last_niche,
         (ARRAY_AGG(spq_overall ORDER BY created_at DESC))[1] AS last_spq
       FROM expanded
       GROUP BY symptom
       ORDER BY frequency DESC, last_seen_at DESC
       LIMIT $2`,
      [days, limit],
    );
    res.json({ days, items: r.rows });
  } catch (e) {
    res.json({ days, items: [], warning: e.message });
  }
}

module.exports.listQualityLog   = listQualityLog;
module.exports.listTopFailures  = listTopFailures;

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

// ─────────────────────────── Phase 14 ───────────────────────────────

/**
 * POST /api/aegis/vector-gc/sweep (admin)
 *
 * Запускает TTL-чистку Qdrant: удаляет точки старше N дней в эфемерных
 * коллекциях (evidence_*, serp_*, relevance_*) с предохранителем
 * min_age_safety_hours. Параметры опциональны — берутся из featureFlags.
 */
async function runVectorGcSweep(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { ttl_days, ephemeral_prefixes, min_age_safety_hours, dry_run } = req.body || {};
  const r = await vectorGc.sweep({
    ttlDays: ttl_days,
    ephemeralPrefixes: ephemeral_prefixes,
    minAgeSafetyHours: min_age_safety_hours,
    dryRun: dry_run,
  });
  if (!r.ok && r.reason === 'disabled') return res.status(409).json({ error: 'vector_gc_disabled' });
  if (!r.ok) return res.status(503).json({ error: 'vector_gc_failed', reason: r.reason });
  // Persist в aegis_vector_gc_log (best-effort).
  try {
    await db.query(
      `INSERT INTO aegis_vector_gc_log (mode, status, params, result)
       VALUES ($1, $2, $3, $4)`,
      ['sweep', 'ok', JSON.stringify(req.body || {}), JSON.stringify(r.body || {})],
    );
  } catch (_e) { /* table may not exist on legacy DB */ }
  res.json({ ok: true, body: r.body });
}

/**
 * POST /api/aegis/vector-gc/cleanup (admin)
 *
 * Зачистка точек конкретного run_id (после success). { run_id: string }.
 */
async function runVectorGcCleanup(req, res) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { run_id } = req.body || {};
  if (!run_id || typeof run_id !== 'string') {
    return res.status(400).json({ error: 'run_id_required' });
  }
  const r = await vectorGc.cleanupRun({ runId: run_id });
  if (!r.ok && r.reason === 'disabled') return res.status(409).json({ error: 'vector_gc_disabled' });
  if (!r.ok) return res.status(503).json({ error: 'vector_gc_cleanup_failed', reason: r.reason });
  try {
    await db.query(
      `INSERT INTO aegis_vector_gc_log (mode, status, params, result)
       VALUES ($1, $2, $3, $4)`,
      ['cleanup', 'ok', JSON.stringify({ run_id }), JSON.stringify(r.body || {})],
    );
  } catch (_e) { /* legacy DB */ }
  res.json({ ok: true, body: r.body });
}
