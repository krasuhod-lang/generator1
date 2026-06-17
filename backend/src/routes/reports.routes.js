'use strict';

/**
 * Routes модуля «Smart Report Builder» (приватные эндпоинты).
 * Публичные роуты — в reportsPublic.routes.js.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const c = require('../controllers/reports.controller');

const router = express.Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      300,
  standardHeaders: true,
  legacyHeaders:   false,
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
});
const llmLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запусков AI. Подождите минуту.' },
});
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      12,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много экспортов. Подождите минуту.' },
});

router.use(readLimiter);

// CRUD
router.get('/drafts',         auth, c.listDrafts);
router.post('/drafts',        auth, writeLimiter, c.createDraft);
router.get('/drafts/:id',     auth, c.getDraft);
router.put('/drafts/:id',     auth, writeLimiter, c.updateDraft);
router.delete('/drafts/:id',  auth, writeLimiter, c.deleteDraft);

router.put('/drafts/:id/tasks-blocks', auth, writeLimiter, c.updateTasksBlocks);
router.get('/drafts/:id/tasks',        auth, c.listProjectTasks);

// Данные + AI
router.get('/drafts/:id/data',                         auth, c.getDraftData);
router.post('/drafts/:id/generate-summary',            auth, llmLimiter, c.generateSummaryEndpoint);
router.get('/drafts/:id/generate-summary/status',      auth, c.getSummaryStatus);
router.post('/drafts/:id/export.docx',                 auth, exportLimiter, c.exportDraftDocx);

// Публикация
router.post('/drafts/:id/publish',          auth, writeLimiter, c.publishDraft);
router.get('/shared',                       auth, c.listShared);
router.put('/shared/:uuid/settings',        auth, writeLimiter, c.updateSharedSettings);
router.post('/shared/:uuid/revoke',         auth, writeLimiter, c.revokeShared);

module.exports = router;
