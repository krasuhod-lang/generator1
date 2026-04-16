'use strict';

const express    = require('express');
const authMiddleware = require('../middleware/auth');
const {
  register,
  login,
  logout,
  me,
} = require('../controllers/auth.controller');

const router = express.Router();

// POST /api/auth/register — регистрация (публичный)
router.post('/register', register);

// POST /api/auth/login — логин (публичный)
router.post('/login', login);

// POST /api/auth/logout — логаут (публичный — клиент просто удаляет токен)
router.post('/logout', logout);

// GET /api/auth/me — текущий пользователь (требует JWT)
router.get('/me', authMiddleware, me);

module.exports = router;
