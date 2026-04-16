'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const db     = require('../config/db');

// ─────────────────────────────────────────────────────────────────────────────
// Вспомогательные функции
// ─────────────────────────────────────────────────────────────────────────────

/** Создаёт JWT со сроком из JWT_EXPIRES_IN (по умолчанию 7d). */
function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

/** Валидация e-mail простым regex. */
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Регистрация нового пользователя.
 * Body: { email, password, name? }
 */
async function register(req, res, next) {
  try {
    const { email, password, name } = req.body;

    // Валидация входных данных
    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Некорректный email' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Пароль должен содержать минимум 8 символов' });
    }

    // Проверяем, не занят ли email
    const existing = await db.query(
      `SELECT id FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Пользователь с таким email уже существует' });
    }

    // Хешируем пароль (bcrypt, cost=12)
    const passwordHash = await bcrypt.hash(password, 12);

    // Создаём пользователя
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, name)
       VALUES ($1, $2, $3)
       RETURNING id, email, name, created_at`,
      [email.toLowerCase().trim(), passwordHash, name || null]
    );
    const user = rows[0];

    // Выпускаем JWT
    const token = signToken({ id: user.id, email: user.email });

    return res.status(201).json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Логин пользователя.
 * Body: { email, password }
 * Returns: { token, user: { id, email, name } }
 */
async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email и пароль обязательны' });
    }

    // Ищем пользователя
    const { rows } = await db.query(
      `SELECT id, email, name, password_hash FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );
    if (!rows.length) {
      // Одинаковое сообщение для безопасности (не раскрываем, есть ли пользователь)
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const user = rows[0];

    // Проверяем пароль
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }

    // Выпускаем JWT
    const token = signToken({ id: user.id, email: user.email });

    return res.json({
      token,
      user: { id: user.id, email: user.email, name: user.name },
    });

  } catch (err) {
    next(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout  (stateless JWT — клиент просто удаляет токен)
// ─────────────────────────────────────────────────────────────────────────────

function logout(req, res) {
  // JWT stateless — реальная инвалидация требует blacklist в Redis (опционально).
  // Достаточно сообщить клиенту, что он должен удалить токен.
  return res.json({ message: 'Logged out. Delete token on client side.' });
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me  (требует JWT)
// ─────────────────────────────────────────────────────────────────────────────

async function me(req, res, next) {
  try {
    const { rows } = await db.query(
      `SELECT id, email, name, created_at FROM users WHERE id = $1`,
      [req.user.id]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Пользователь не найден' });
    }
    return res.json({ user: rows[0] });

  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, logout, me };
