'use strict';

const express        = require('express');
const rateLimit      = require('express-rate-limit');
const jwt            = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');

const {
  getPresets, getSession, listOperations, getOperation,
  createOperation, streamOperation, cancelOperation, applyOperation,
  saveEditedHtml,
} = require('../controllers/editorCopilot.controller');

const router = express.Router();

// SSE auth — принимает токен из ?token= (EventSource не поддерживает заголовки).
// Идентичен авторизации в tasks.routes.js
function authSSE(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Лимит на создание операции — защита от спама/cost-runaway. 30/мин/IP.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к AI-Copilot. Попробуйте через минуту.' },
});

// Общий read-лимитер для остальных endpoint'ов (включая SSE) —
// 240/мин/IP. Достаточно для интерактивного UI с автообновлениями,
// но защищает от боттов и accidental loops в клиенте.
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к AI-Copilot. Попробуйте позже.' },
});

// Презенты + модель
router.get('/presets', authMiddleware, readLimiter, getPresets);

// Сессия и список операций
router.get('/:taskId/session',                authMiddleware, readLimiter, getSession);
router.get('/:taskId/operations',             authMiddleware, readLimiter, listOperations);
router.get('/:taskId/operations/:opId',       authMiddleware, readLimiter, getOperation);

// Создание / отмена / применение
router.post('/:taskId/operations',            authMiddleware, createLimiter, createOperation);
router.post('/:taskId/operations/:opId/cancel', authMiddleware, readLimiter, cancelOperation);
router.post('/:taskId/operations/:opId/apply',  authMiddleware, readLimiter, applyOperation);

// Ручное сохранение HTML после правок руками (без AI-операции)
router.post('/:taskId/html-edited',           authMiddleware, readLimiter, saveEditedHtml);

// SSE-стрим — в отдельном authSSE
router.get('/:taskId/operations/:opId/stream', authSSE, readLimiter, streamOperation);

module.exports = router;
