'use strict';

const jwt = require('jsonwebtoken');
const db  = require('../config/db');

/**
 * Admin Auth Middleware.
 * Проверяет JWT + role='admin' в БД.
 * При успехе: req.user = { id, email, role }
 */
module.exports = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Быстрая проверка: если в токене нет role='admin' — сразу отказ
    if (decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    // Подтверждаем роль из БД (на случай отзыва прав)
    const { rows } = await db.query(
      `SELECT id, email, role FROM users WHERE id = $1 AND role = 'admin'`,
      [decoded.id]
    );
    if (!rows.length) {
      return res.status(403).json({ error: 'Forbidden: admin access required' });
    }

    req.user = { id: rows[0].id, email: rows[0].email, role: rows[0].role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
