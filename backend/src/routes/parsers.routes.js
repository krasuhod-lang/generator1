'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const parsersController = require('../controllers/parsers.controller');

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов на скачивание. Попробуйте позже.' },
});

router.post('/start', parsersController.startParsing);
router.get('/status/:taskId', parsersController.getTaskStatus);
router.post('/cancel/:taskId', parsersController.cancelTask);
router.post('/retry-failed/:taskId', parsersController.retryFailed);
router.get('/download/:taskId', downloadLimiter, parsersController.downloadReport);

module.exports = router;
