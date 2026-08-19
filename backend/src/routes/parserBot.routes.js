'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const controller = require('../controllers/parserBot.controller');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов parser-bot. Попробуйте позже.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post('/scans', writeLimiter, auth, controller.createScan);
router.get('/scans', readLimiter, auth, controller.listScans);
router.get('/scans/:id', readLimiter, auth, controller.getScan);
router.get('/scans/:id/items', readLimiter, auth, controller.listItems);
router.get('/scans/:id/items/:itemId', readLimiter, auth, controller.getItem);
router.post('/scans/:id/cancel', writeLimiter, auth, controller.cancelScan);
router.post('/scans/:id/retry', writeLimiter, auth, controller.retryFailed);
router.get('/scans/:id/export.json', readLimiter, auth, controller.exportJson);
router.get('/scans/:id/export.xlsx', readLimiter, auth, controller.exportXlsx);

module.exports = router;
