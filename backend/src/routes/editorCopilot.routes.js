'use strict';

const express        = require('express');
const rateLimit      = require('express-rate-limit');
const jwt            = require('jsonwebtoken');
const authMiddleware = require('../middleware/auth');
const db = require('../config/db');
const { ensureAccessProfile } = require('../services/access/entitlementPolicy');

const {
  getPresets, getSession, listOperations, getOperation,
  createOperation, streamOperation, cancelOperation, applyOperation,
  saveEditedHtml,
} = require('../controllers/editorCopilot.controller');

const router = express.Router();

// SSE auth — принимает токен из ?token= (EventSource не поддерживает заголовки).
// Идентичен авторизации в tasks.routes.js
async function authSSE(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const profile = await ensureAccessProfile(decoded.id, db);
    if (!profile) return res.status(401).json({ error: 'Invalid or expired token' });
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role: profile.account_role,
      accountRole: profile.account_role,
      plan: profile.plan_key,
      accessStatus: profile.status,
    };
    return next();
  } catch (_) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function staffOnly(req, res, next) {
  const role = String(req.user?.accountRole || req.user?.role || '').toLowerCase();
  if (role === 'client' || role === 'user') {
    return res.status(403).json({ error: 'AI-редактор и технические данные доступны только сотрудникам и администраторам', code: 'technical_visibility_restricted' });
  }
  return next();
}

// Лимит на создание операции — самый строгий, защита от cost-runaway. 30/мин/IP.
const createLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к AI-Copilot. Попробуйте через минуту.' },
});

// Общий лимитер для ВСЕХ остальных endpoint'ов (включая SSE) — 240/мин/IP.
// Применяется как router-level middleware, чтобы покрыть все маршруты этого
// файла одним вызовом (защита от любого «забытого» эндпоинта).
const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      240,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к AI-Copilot. Попробуйте позже.' },
});

router.use(readLimiter);

// Презенты + модель
router.get('/presets', authMiddleware, staffOnly, getPresets);

// Сессия и список операций
router.get('/:taskId/session',                authMiddleware, staffOnly, getSession);
router.get('/:taskId/operations',             authMiddleware, staffOnly, listOperations);
router.get('/:taskId/operations/:opId',       authMiddleware, staffOnly, getOperation);

// Создание / отмена / применение — create имеет дополнительный, более строгий лимитер
router.post('/:taskId/operations',            authMiddleware, staffOnly, createLimiter, createOperation);
router.post('/:taskId/operations/:opId/cancel', authMiddleware, staffOnly, cancelOperation);
router.post('/:taskId/operations/:opId/apply',  authMiddleware, staffOnly, applyOperation);

// Ручное сохранение HTML после правок руками (без AI-операции)
router.post('/:taskId/html-edited',           authMiddleware, staffOnly, saveEditedHtml);

// SSE-стрим — в отдельном authSSE
router.get('/:taskId/operations/:opId/stream', authSSE, staffOnly, streamOperation);

module.exports = router;
