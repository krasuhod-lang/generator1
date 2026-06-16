'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const ctrl = require('../controllers/positionTracker.controller');

const router = express.Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

// «Тяжёлые» эндпоинты — старт нового съёма XMLStock — отдельно лимитируем.
const runLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запусков съёма за минуту. Подождите.' },
});

router.use(readLimiter);

// Проекты
router.get   ('/projects',         auth, ctrl.listProjects);
router.post  ('/projects',         auth, ctrl.createProject);
router.get   ('/projects/:id',     auth, ctrl.getProject);
router.patch ('/projects/:id',     auth, ctrl.updateProject);
router.delete('/projects/:id',     auth, ctrl.deleteProject);

// Запросы
router.post  ('/projects/:id/keywords',           auth, ctrl.addKeywords);
router.delete('/projects/:id/keywords/:kwId',     auth, ctrl.deleteKeyword);

// Снятие позиций
router.post('/projects/:id/runs', auth, runLimiter, ctrl.startRun);
router.get ('/projects/:id/runs', auth, ctrl.listRuns);

// Аналитика
router.get('/projects/:id/summary',                  auth, ctrl.getSummary);
router.get('/projects/:id/series',                   auth, ctrl.getProjectSeries);
router.get('/projects/:id/keywords/:kwId/series',    auth, ctrl.getKeywordSeries);
router.get('/projects/:id/keywords-table',           auth, ctrl.getKeywordsTable);
router.get('/projects/:id/movers',                   auth, ctrl.getMovers);

module.exports = router;
