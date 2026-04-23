'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const auth      = require('../middleware/auth');

const {
  listLinkArticleTasks,
  createLinkArticleTask,
  getLinkArticleTask,
  deleteLinkArticleTask,
  streamLinkArticleTask,
} = require('../controllers/linkArticle.controller');

const router = express.Router();

/**
 * SSE-совместимый auth: EventSource не умеет выставлять заголовок
 * Authorization, поэтому для /stream принимаем токен также из query
 * (?token=JWT). В остальных эндпоинтах используется обычный auth.
 */
function sseAuth(req, res, next) {
  const hdr = req.headers['authorization'];
  const bearer = hdr && hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const token  = bearer || (typeof req.query.token === 'string' ? req.query.token : null);
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email };
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

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

const streamLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60, // один пользователь может переподключаться до 60 раз/мин
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много SSE-подключений. Подождите.' },
});

// SSE-поток: EventSource не умеет выставлять Authorization, поэтому
// `sseAuth` принимает токен из query-параметра (?token=). Это документированный
// trade-off: токен может попасть в логи сервера. Роут ограничен rate-limit'ом,
// чтобы снизить риск перебора токенов, но для полной защиты рекомендуется
// использовать короткоживущие токены (security follow-up).
router.get('/:id/stream',  streamLimiter, sseAuth, streamLinkArticleTask);

router.use(readLimiter);

router.get('/',            auth, listLinkArticleTasks);
router.post('/',           auth, createLimiter, createLinkArticleTask);
router.get('/:id',         auth, getLinkArticleTask);
router.delete('/:id',      auth, deleteLinkArticleTask);

module.exports = router;
