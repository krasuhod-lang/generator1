'use strict';
/**
 * Роут авто-заполнения прогнозатора по сайту (V2). Монтируется в server.js на
 * '/api/forecaster' ОТДЕЛЬНЫМ роутером — существующий forecaster.routes не трогаем.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');

const { prefillFromDomainV2 } = require('../controllers/forecasterPrefill.controller');

const router = express.Router();

// keys.so-запросы недёшевы — ограничиваем чаще, чем обычные чтения.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});
router.use(limiter);

// POST /api/forecaster/prefill-from-domain
router.post('/prefill-from-domain', auth, prefillFromDomainV2);

module.exports = router;
