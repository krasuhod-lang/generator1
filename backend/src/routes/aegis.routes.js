'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  getStatus,
  listBacklog,
  createBacklogItem,
  retryBacklogItem,
  triggerDspyRetrain,
  proposeMutation,
  listRuns,
  listBrainVersions,
  getMetrics,
  getKillSwitch,
  postKillSwitch,
  getSpendRate,
  getRouterBreakers,
  runBackupNow,
  listBackups,
  runVectorGcSweep,
  runVectorGcCleanup,
  listQualityLog,
  listTopFailures,
  listPromptAuditLog,
  getSeoBrainSnapshot,
  analyzeSeoBrain,
  observeSeoPages,
  prunePromptAuditHandler,
  dispatchSeoActions,
} = require('../controllers/aegis.controller');

const router = express.Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к /api/aegis. Попробуйте позже.' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много модифицирующих запросов к /api/aegis.' },
});

router.use(readLimiter);

router.get('/status',          auth, getStatus);
router.get('/backlog',         auth, listBacklog);
router.post('/backlog',        auth, writeLimiter, createBacklogItem);
router.post('/backlog/:number/retry', auth, writeLimiter, retryBacklogItem);
router.post('/dspy/retrain',   auth, writeLimiter, triggerDspyRetrain);
router.post('/mutate/propose', auth, writeLimiter, proposeMutation);
router.get('/runs',            auth, listRuns);
router.get('/brain/versions',  auth, listBrainVersions);

// Phase 9–13: observability / FinOps / kill switch / routing / backup.
// /metrics НЕ требует auth — это стандарт для Prometheus-скрейперов.
// Доступ ограничивается на уровне сети/reverse-proxy (см. AEGIS_SETUP.md).
router.get('/metrics',          getMetrics);
router.get('/kill',             auth, getKillSwitch);
router.post('/kill',            auth, writeLimiter, postKillSwitch);
router.get('/finops/spend',     auth, getSpendRate);
router.get('/router/breakers',  auth, getRouterBreakers);
router.post('/backup/run',      auth, writeLimiter, runBackupNow);
router.get('/backup/list',      auth, listBackups);

// Phase 14: Vector-DB GC (TTL sweep + per-run cleanup).
router.post('/vector-gc/sweep',   auth, writeLimiter, runVectorGcSweep);
router.post('/vector-gc/cleanup', auth, writeLimiter, runVectorGcCleanup);

// Discovery (Слои 1/3/8 плана) — read-only телеметрия для дашборда.
router.get('/quality-log',  auth, listQualityLog);
router.get('/failures/top', auth, listTopFailures);
router.get('/prompts/log',  auth, listPromptAuditLog);

// Phase 15: SEO Brain — site memory / reward / diagnostics / safe action-plan.
// B5: явный body cap 5 MB на /analyze и /observe — защита от 200 MB JSON apocalypse.
const seoBrainBody = express.json({ limit: '5mb' });
router.get('/seo-brain',         auth, getSeoBrainSnapshot);
router.post('/seo-brain/analyze', auth, writeLimiter, seoBrainBody, analyzeSeoBrain);

// Phase 15.C: SEO observations (GSC/Яндекс delta → reward → dataset backfill).
router.post('/seo-brain/pages/observe', auth, writeLimiter, seoBrainBody, observeSeoPages);

// Phase A4: retention для prompt audit (admin-only ручной/cron triggered cleanup).
router.post('/prompts/prune', auth, writeLimiter, prunePromptAuditHandler);

// Phase C2: bridge SEO actions → GitHub backlog issues.
router.post('/seo-brain/actions/dispatch', auth, writeLimiter, dispatchSeoActions);

// ── Bio-Brain B5/B1: read-only timeline + admin tools ────────────
const {
  listBiobrainGenerations,
  listAlgoUpdates,
  refreshAlgoUpdates,
  listSerpOutcomes,
  listExperiments,
  runExperimentsNow,
  dispatchExperimentHandler,
  measureExperimentHandler,
} = require('../controllers/aegis.controller');
router.get('/biobrain/generations', auth, listBiobrainGenerations);
router.get('/algo-updates',         auth, listAlgoUpdates);
router.post('/algo-updates/refresh', auth, writeLimiter, refreshAlgoUpdates);
router.get('/serp-outcomes',        auth, listSerpOutcomes);

// B4: experiments — мозг сам ставит себе эксперименты.
router.get('/experiments',                  auth, listExperiments);
router.post('/experiments/run',             auth, writeLimiter, runExperimentsNow);
router.post('/experiments/:id/dispatch',    auth, writeLimiter, dispatchExperimentHandler);
router.post('/experiments/:id/measure',     auth, writeLimiter, express.json({ limit: '64kb' }), measureExperimentHandler);

// Phase B: единая диагностика готовности контура обучения (DSPy + RL/PPO по CTR из GSC + Яндекс.Вебмастера).
// Возвращает env-чек-лист, ping aegis_py, статистику aegis_dspy_dataset,
// последнюю запись aegis_brain_versions, размер baseline-yaml и список
// конкретных шагов, которые остались оператору.
const { getTrainingHealth } = require('../controllers/aegis.controller');
router.get('/training/health', auth, getTrainingHealth);

module.exports = router;
