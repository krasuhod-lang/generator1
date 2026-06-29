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
  getFunnelBreakdown,
  getAegisCostBreakdown,
  listAdminProjects,
  listAdminProjectGrants,
  createAdminProjectGrant,
  updateAdminProjectGrant,
  revokeAdminProjectGrant,
  listAdminGrantableUsers,
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

// Воронки генерации — пошаговая воронка по kind, conversion-rate, причины
// отказов, стоимость/латентность success vs fail (generation_funnels, мигр. 054).
router.get('/funnels',            apiLimiter, adminAuth, getFunnelBreakdown);

// Расходы Эгиды по дням — посуточный учёт расхода лимитов мозга (токены,
// стоимость USD, доля prompt-кэша). Фильтр периода from/to (aegis_llm_usage,
// мигр. 055).
router.get('/aegis-costs',        apiLimiter, adminAuth, getAegisCostBreakdown);

// ── Project grants (миграция 092, задача 1) ─────────────────────────
// Раздача доступов к проектам, их анализам и отчётам через панель админа.
router.get   ('/projects',                           apiLimiter, adminAuth, listAdminProjects);
router.get   ('/projects/:id/grants',                apiLimiter, adminAuth, listAdminProjectGrants);
router.get   ('/projects/:id/grantable-users',       apiLimiter, adminAuth, listAdminGrantableUsers);
router.post  ('/projects/:id/grants',                apiLimiter, adminAuth, createAdminProjectGrant);
router.patch ('/projects/:id/grants/:grantId',       apiLimiter, adminAuth, updateAdminProjectGrant);
router.delete('/projects/:id/grants/:grantId',       apiLimiter, adminAuth, revokeAdminProjectGrant);

module.exports = router;
