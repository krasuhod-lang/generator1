'use strict';
/**
 * Роуты провокационного режима outreach (V2). Монтируются в server.js на
 * '/api/outreach' ОТДЕЛЬНЫМ роутером — существующий outreach.routes не трогаем.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');

const { previewProvocationV2 } = require('../controllers/outreachProvocation.controller');

const router = express.Router();

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});
router.use(limiter);

// Предпросмотр провокационного письма по одному лиду (без отправки).
router.post('/prospects/:id/preview-provocation', auth, previewProvocationV2);

module.exports = router;
