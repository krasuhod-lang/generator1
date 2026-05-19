'use strict';

/**
 * Публичный read-only роут для share-ссылок.
 * НЕ требует auth, но имеет собственный rate-limit (защита от перебора токенов).
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const { getSharedForecast } = require('../controllers/forecaster.controller');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(publicLimiter);

router.get('/forecaster/:token', getSharedForecast);

module.exports = router;
