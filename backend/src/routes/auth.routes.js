'use strict';

const express    = require('express');
const rateLimit  = require('express-rate-limit');
const authMiddleware = require('../middleware/auth');
const {
  register,
  login,
  logout,
  me,
} = require('../controllers/auth.controller');

const router = express.Router();

// Anti-bruteforce: ограничиваем логин и регистрацию.
// Точечный лимит на /login и /register — глобальный rate-limit нам не подходит,
// т.к. /api/* шлют SSE/poll с большой частотой. Ключ — IP (default).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,           // 15 минут окно
  max: parseInt(process.env.AUTH_LOGIN_RATE_LIMIT, 10) || 10,
  standardHeaders: true,
  legacyHeaders:   false,
  // Не считаем удачные логины — иначе легитимный пользователь, который часто
  // обновляет токен, упирается в лимит.
  skipSuccessfulRequests: true,
  message: { error: 'Слишком много попыток входа. Попробуйте позже.' },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,           // 1 час окно
  max: parseInt(process.env.AUTH_REGISTER_RATE_LIMIT, 10) || 5,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много регистраций с этого IP. Попробуйте позже.' },
});

// POST /api/auth/register — регистрация (публичный + лимит)
router.post('/register', registerLimiter, register);

// POST /api/auth/login — логин (публичный + лимит)
router.post('/login', loginLimiter, login);

// POST /api/auth/logout — логаут (публичный — клиент просто удаляет токен)
router.post('/logout', logout);

// GET /api/auth/me — текущий пользователь (требует JWT)
router.get('/me', authMiddleware, me);

module.exports = router;
