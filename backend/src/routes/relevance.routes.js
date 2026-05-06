'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listReports, createReport,
  getReport, deleteReport,
  buildCocoons, deleteRaw,
  exportJson, exportCsv, getHealth,
} = require('../controllers/relevance.controller');

const router = express.Router();

// Создание отчёта дёргает XMLStock + 20 страниц + Python — самый дорогой
// эндпоинт. Лимит 20/мин/IP. Чтения мягче. Cocoons — отдельный, средний.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много отчётов за последнюю минуту. Подождите.' },
});

const cocoonsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много пересчётов коконов. Подождите.' },
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
router.post('/:id/cocoons',          auth, cocoonsLimiter, buildCocoons);
router.delete('/:id/raw',            auth, deleteRaw);
router.get('/:id/export.json',       auth, exportJson);
router.get('/:id/export.csv',        auth, exportCsv);

module.exports = router;
