'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listReports, createReport,
  getReport, deleteReport,
  exportJson, exportCsv, getHealth,
} = require('../controllers/relevance.controller');

const router = express.Router();

// Создание отчёта дёргает XMLStock + 20 страниц + Python — самый дорогой
// эндпоинт. Лимит 20/мин/IP. Чтения мягче.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много отчётов за последнюю минуту. Подождите.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(readLimiter);

router.get('/health',                auth, getHealth);
router.get('/',                      auth, listReports);
router.post('/',                     auth, createLimiter, createReport);
router.get('/:id',                   auth, getReport);
router.delete('/:id',                auth, deleteReport);
router.get('/:id/export.json',       auth, exportJson);
router.get('/:id/export.csv',        auth, exportCsv);

module.exports = router;
