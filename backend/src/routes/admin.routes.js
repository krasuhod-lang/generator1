'use strict';

const express        = require('express');
const rateLimit      = require('express-rate-limit');
const adminAuth      = require('../middleware/adminAuth');
const {
  adminLogin,
  listUsers,
  getUserDetail,
  getUserTasks,
  getStats,
  listAllTasks,
  getAdminTaskDetail,
  getAdminTaskLogs,
  getModelComparison,
  getUserAllTasks,
  getCrossTaskDetail,
} = require('../controllers/admin.controller');

const router = express.Router();

// Rate limiter для логина — максимум 5 попыток в минуту
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много попыток входа. Попробуйте через минуту.' },
});

// Rate limiter для API — максимум 60 запросов в минуту
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

// POST /api/admin/login — публичный, с rate limit
router.post('/login', loginLimiter, adminLogin);

// Все остальные — через adminAuth middleware + rate limit
router.get('/users',              apiLimiter, adminAuth, listUsers);
router.get('/users/:userId',      apiLimiter, adminAuth, getUserDetail);
router.get('/users/:userId/tasks', apiLimiter, adminAuth, getUserTasks);
router.get('/users/:userId/all-tasks', apiLimiter, adminAuth, getUserAllTasks);
router.get('/stats',              apiLimiter, adminAuth, getStats);

// Per-task admin views (Point 8) — task_logs reused from /api/tasks/:id/logs.
router.get('/tasks',              apiLimiter, adminAuth, listAllTasks);
router.get('/tasks/:id',          apiLimiter, adminAuth, getAdminTaskDetail);
router.get('/tasks/:id/logs',     apiLimiter, adminAuth, getAdminTaskLogs);

// Cross-module task detail (UNION across 7 task tables).
router.get('/cross-tasks/:source/:id', apiLimiter, adminAuth, getCrossTaskDetail);

// Model quality comparison — агрегат quality_score по моделям (миграция 037).
router.get('/model-comparison',   apiLimiter, adminAuth, getModelComparison);

module.exports = router;
