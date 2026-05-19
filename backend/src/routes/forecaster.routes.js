'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listForecasterTasks,
  createForecasterTask,
  getForecasterTask,
  deleteForecasterTask,
  createShareLink,
  revokeShareLink,
} = require('../controllers/forecaster.controller');

const router = express.Router();

// Создание задачи — отдельный, более жёсткий лимит, как в article-topics.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      10,
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

router.get('/',                  auth, listForecasterTasks);
router.post('/',                 auth, createLimiter, createForecasterTask);
router.get('/:id',               auth, getForecasterTask);
router.delete('/:id',            auth, deleteForecasterTask);
router.post('/:id/share',        auth, createShareLink);
router.delete('/:id/share',      auth, revokeShareLink);

module.exports = router;
