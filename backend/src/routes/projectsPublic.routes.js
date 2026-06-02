'use strict';

/**
 * Публичные роуты модуля «Проекты» (без auth):
 *   • GET /projects/gsc/callback — OAuth-колбэк Google (браузерный редирект)
 *   • GET /project/:token        — read-only публичный дашборд по share-ссылке
 *
 * Монтируется в server.js под '/api/public'. Дополнительно в server.js
 * зарегистрирован алиас GET /api/oauth/google/callback → handleGscCallback
 * для совместимости с ранее настроенным в Google Cloud redirect_uri.
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');

const c = require('../controllers/projects.controller');

const router = express.Router();

const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});

router.use(publicLimiter);

router.get('/projects/gsc/callback', c.handleGscCallback);
router.get('/project/:token',        c.getSharedProject);

module.exports = router;
