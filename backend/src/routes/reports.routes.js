'use strict';

/**
 * Routes модуля «Smart Report Builder» (приватные эндпоинты).
 * Публичные роуты — в reportsPublic.routes.js.
 */

const path      = require('path');
const fs        = require('fs');
const express   = require('express');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const auth      = require('../middleware/auth');

const c = require('../controllers/reports.controller');

const router = express.Router();

// ── Image upload for task descriptions ─────────────────────────────────────
const imgDir = path.join(__dirname, '../../../uploads/report-images');
if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });

const imgStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, imgDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const imgUpload = multer({
  storage: imgStorage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только изображения (PNG, JPEG, GIF, WebP)'));
  },
});

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
  message: { error: 'Слишком много запросов. Подождите минуту.' },
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
// ТЗ §6: ручные правки чисел и AI-блоков в черновике
router.patch('/drafts/:id/overrides',  auth, writeLimiter, c.patchOverrides);
router.patch('/drafts/:id/summary',    auth, writeLimiter, c.patchSummary);

// Данные + AI
router.get('/drafts/:id/data',                         auth, c.getDraftData);
router.post('/drafts/:id/generate-summary',            auth, llmLimiter, c.generateSummaryEndpoint);
router.get('/drafts/:id/generate-summary/status',      auth, c.getSummaryStatus);
router.post('/drafts/:id/export.docx',                 auth, exportLimiter, c.exportDraftDocx);
router.post('/drafts/:id/export.pdf',                  auth, exportLimiter, c.exportDraftPdf);

// Публикация
router.post('/drafts/:id/publish',          auth, writeLimiter, c.publishDraft);
router.get('/shared',                       auth, c.listShared);
router.put('/shared/:uuid/settings',        auth, writeLimiter, c.updateSharedSettings);
router.post('/shared/:uuid/revoke',         auth, writeLimiter, c.revokeShared);

// Загрузка изображений для описаний задач
router.post('/upload-image', auth, writeLimiter, imgUpload.single('image'), c.uploadTaskImage);

module.exports = router;
