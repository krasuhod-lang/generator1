'use strict';

const jwt = require('jsonwebtoken');
const { ensureAccessProfile } = require('../services/access/entitlementPolicy');
const db = require('../config/db');

/**
 * Normal user JWT middleware. The JWT identifies the account only; current
 * role/plan is always read from PostgreSQL so admin changes take effect
 * immediately and a stale token cannot elevate a client.
 */
module.exports = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) return res.status(401).json({ error: 'Invalid or expired token' });
    const profile = await ensureAccessProfile(decoded.id, db);
    if (!profile) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = {
      id: profile.id,
      email: profile.email,
      name: profile.name,
      role: profile.account_role,
      accountRole: profile.account_role,
      plan: profile.plan_key,
    };
    return next();
  } catch (err) {
    // Do not fail open if access schema/DB is unavailable.
    console.error('[auth] access context failed:', err.message);
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    return res.status(503).json({ error: 'Сервис авторизации временно недоступен' });
  }
};
