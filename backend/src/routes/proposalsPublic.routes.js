'use strict';

/**
 * Публичный read-only роут для share-ссылок КП («Фронт работ»).
 * Без auth, с собственным rate-limit (защита от перебора токенов).
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const { getSharedProposal } = require('../controllers/proposals.controller');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(publicLimiter);

router.get('/proposal/:token', getSharedProposal);

module.exports = router;
