'use strict';

/**
 * routes/contentPolicy.routes.js — админ-маршруты V6 «Prompt & Policy Registry»
 * + чтение V1-журнала quality gate. Все под adminAuth.
 *
 * Монтируется в server.js как app.use('/api/admin/content-policy', …).
 */

const express   = require('express');
const rateLimit = require('express-rate-limit');
const adminAuth  = require('../middleware/adminAuth');
const c          = require('../controllers/contentPolicy.controller');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'too_many_requests' },
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
});

router.get   ('/rules',         readLimiter,  adminAuth, c.listRules);
router.post  ('/rules',         writeLimiter, adminAuth, c.createRule);
router.patch ('/rules/:id',     writeLimiter, adminAuth, c.updateRule);
router.delete('/rules/:id',     writeLimiter, adminAuth, c.deleteRule);
router.get   ('/effective',     readLimiter,  adminAuth, c.effectivePolicy);
router.get   ('/gate-reports',  readLimiter,  adminAuth, c.listGateReports);

module.exports = router;
