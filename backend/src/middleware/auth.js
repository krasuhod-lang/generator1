'use strict';

const jwt = require('jsonwebtoken');

/**
 * JWT Auth Middleware.
 * Ожидает заголовок: Authorization: Bearer <token>
 * При успехе добавляет req.user = { id, email }
 */
module.exports = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};
