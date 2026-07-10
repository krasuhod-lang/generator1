'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');
const c         = require('../controllers/audit.controller');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много задач за минуту. Подождите.' },
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
});

router.post  ('/start',      writeLimiter, auth, c.startAudit);
router.get   ('/tasks',      readLimiter,  auth, c.listTasks);
router.get   ('/status/:id', readLimiter,  auth, c.getStatus);
router.get   ('/report/:id', readLimiter,  auth, c.getReport);
router.get   ('/export/:id', readLimiter,  auth, c.exportReport);
router.delete('/:id',        writeLimiter, auth, c.deleteTask);

module.exports = router;
