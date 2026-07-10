'use strict';

/**
 * Публичный read-only роут для share-ссылок аудита (ТЗ 9 — клиентский отчёт).
 * Без auth, с собственным rate-limit (защита от перебора токенов).
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const { getSharedReport } = require('../controllers/audit.controller');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(publicLimiter);

router.get('/audit/:token', getSharedReport);

module.exports = router;
