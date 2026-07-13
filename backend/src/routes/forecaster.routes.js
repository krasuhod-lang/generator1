'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listForecasterTasks,
  createForecasterTask,
  getForecasterTask,
  deleteForecasterTask,
  rerunForecasterTask,
  regenerateForecastReport,
  createShareLink,
  revokeShareLink,
} = require('../controllers/forecaster.controller');

const router = express.Router();

// Глобальный express.json в server.js ограничен 10 МБ — это разумно для
// большинства API, но прогнозатор обязан принимать большие выгрузки
// Wordstat (сотни тысяч фраз × 16+ месяцев). Поэтому для POST-роутов
// форкастера используем отдельный JSON-парсер с поднятым лимитом —
// глобальный middleware при этом не трогаем.
const bigJson = express.json({ limit: '1024mb' });

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
router.post('/',                 auth, bigJson, createLimiter, createForecasterTask);
router.get('/:id',               auth, getForecasterTask);
router.delete('/:id',            auth, deleteForecasterTask);
router.post('/:id/rerun',        auth, createLimiter, rerunForecasterTask);
router.post('/:id/regenerate-report', auth, createLimiter, regenerateForecastReport);
router.post('/:id/share',        auth, createShareLink);
router.delete('/:id/share',      auth, revokeShareLink);

module.exports = router;
