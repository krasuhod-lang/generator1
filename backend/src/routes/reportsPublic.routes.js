'use strict';

/**
 * Публичные роуты Smart Report Builder (без авторизации):
 *   GET  /api/public/report/:uuid          — JSON отчёта (snapshot или live)
 *   POST /api/public/report/:uuid/unlock   — проверка PIN
 *
 * Монтируется в server.js под '/api/public'.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const c = require('../controllers/reports.controller');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
});
const unlockLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много попыток ввода PIN. Подождите минуту.' },
});

router.get('/report/:uuid',           publicLimiter, c.publicGet);
router.post('/report/:uuid/unlock',   unlockLimiter, c.publicUnlock);
router.post('/report/:uuid/export.docx', publicLimiter, c.publicExportDocx);
router.post('/report/:uuid/export.pdf', publicLimiter, c.publicExportPdf);

module.exports = router;
