'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listCategoryLeadTasks,
  createCategoryLeadTask,
  getCategoryLeadTask,
  deleteCategoryLeadTask,
  exportCategoryLeadCsv,
  exportCategoryLeadMarkdown,
} = require('../controllers/categoryLead.controller');

const router = express.Router();

// Создание — самый дорогой эндпоинт (2 прохода Gemini + опц. парсинг URL/GSC),
// поэтому 20/мин/IP. Чтения и удаления мягче.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много задач за последнюю минуту. Подождите.' },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(readLimiter);

router.get('/',                auth, listCategoryLeadTasks);
router.post('/',               auth, createLimiter, createCategoryLeadTask);
router.get('/:id',             auth, getCategoryLeadTask);
router.delete('/:id',          auth, deleteCategoryLeadTask);
router.get('/:id/export.csv',  auth, exportCategoryLeadCsv);
router.get('/:id/export.md',   auth, exportCategoryLeadMarkdown);

module.exports = router;
