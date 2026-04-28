'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const jwt       = require('jsonwebtoken');
const auth      = require('../middleware/auth');

const {
  listInfoArticleTasks,
  createInfoArticleTask,
  getInfoArticleTask,
  deleteInfoArticleTask,
  streamInfoArticleTask,
} = require('../controllers/infoArticle.controller');

const router = express.Router();

/**
 * SSE-совместимый auth — EventSource не умеет выставлять Authorization,
 * поэтому для /stream принимаем токен также из query (?token=JWT).
 * Trade-off такой же, как в linkArticle.routes.js (документирован там).
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
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много SSE-подключений. Подождите.' },
});

router.get('/:id/stream', streamLimiter, sseAuth, streamInfoArticleTask);

router.use(readLimiter);
router.get('/',       auth, listInfoArticleTasks);
router.post('/',      auth, createLimiter, createInfoArticleTask);
router.get('/:id',    auth, getInfoArticleTask);
router.delete('/:id', auth, deleteInfoArticleTask);

module.exports = router;
