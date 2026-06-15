'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listSerpB2bTasks,
  createSerpB2bTask,
  getSerpB2bTask,
  deleteSerpB2bTask,
  exportSerpB2bXlsx,
} = require('../controllers/serpB2b.controller');

const router = express.Router();

// SERP B2B — самый дорогой эндпоинт (несколько страниц SERP + N сайтов
// + 2 contact-страницы на каждый), поэтому 10/мин/IP. Чтения мягче.
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

router.get('/',                    auth, listSerpB2bTasks);
router.post('/',                   auth, createLimiter, createSerpB2bTask);
router.get('/:id',                 auth, getSerpB2bTask);
router.delete('/:id',              auth, deleteSerpB2bTask);
router.get('/:id/export.xlsx',     auth, exportSerpB2bXlsx);

module.exports = router;
