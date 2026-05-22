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

module.exports = router;
