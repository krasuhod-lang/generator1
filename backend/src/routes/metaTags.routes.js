'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listMetaTagTasks, createMetaTagTask,
  getMetaTagTask, deleteMetaTagTask,
  exportMetaTagTaskCsv,
} = require('../controllers/metaTags.controller');

const router = express.Router();

// Создание новой задачи — самый дорогой эндпоинт (запускает XMLStock + Gemini),
// поэтому ограничиваем 30/мин/IP. Чтения и удаления — мягче.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
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

router.get('/',                   auth, listMetaTagTasks);
router.post('/',                  auth, createLimiter, createMetaTagTask);
router.get('/:id',                auth, getMetaTagTask);
router.delete('/:id',             auth, deleteMetaTagTask);
router.get('/:id/export.csv',     auth, exportMetaTagTaskCsv);

module.exports = router;
