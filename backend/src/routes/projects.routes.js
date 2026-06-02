'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const c = require('../controllers/projects.controller');

const router = express.Router();

const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов за минуту. Подождите.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

// AI-аналитика — тяжёлая (DeepSeek), отдельный жёсткий лимит.
const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запусков анализа. Подождите минуту.' },
});

router.use(readLimiter);

// CRUD
router.get('/',        auth, c.listProjects);
router.post('/',       auth, createLimiter, c.createProject);
router.get('/:id',     auth, c.getProject);
router.put('/:id',     auth, c.updateProject);
router.delete('/:id',  auth, c.deleteProject);

// GSC
router.get('/:id/gsc/auth-url',    auth, c.getGscAuthUrl);
router.get('/:id/gsc/sites',       auth, c.listGscSites);
router.post('/:id/gsc/select-site', auth, c.selectGscSite);
router.delete('/:id/gsc',          auth, c.disconnectGsc);

// Дашборд
router.get('/:id/performance',     auth, c.getPerformance);

// AI-аналитика
router.post('/:id/analyze',        auth, analyzeLimiter, c.startAnalysis);
router.get('/:id/analyses',        auth, c.listAnalyses);
router.get('/:id/analyses/:aid',   auth, c.getAnalysis);

// Шаринг
router.post('/:id/share',          auth, c.createShareLink);
router.delete('/:id/share',        auth, c.revokeShareLink);

module.exports = router;
