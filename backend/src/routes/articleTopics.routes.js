'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  listArticleTopicTasks,
  createArticleTopicTask,
  createArticleTopicDeepDive,
  getArticleTopicTask,
  deleteArticleTopicTask,
} = require('../controllers/articleTopics.controller');

const router = express.Router();

// Создание задачи — отдельный, более жёсткий лимит, чтобы не сжечь Gemini-бюджет
// случайной/злонамеренной тысячей задач.
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

router.get('/',                auth, listArticleTopicTasks);
router.post('/',               auth, createLimiter, createArticleTopicTask);
router.post('/deep-dive',      auth, createLimiter, createArticleTopicDeepDive);
router.get('/:id',             auth, getArticleTopicTask);
router.delete('/:id',          auth, deleteArticleTopicTask);

module.exports = router;
