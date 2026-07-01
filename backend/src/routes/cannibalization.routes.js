'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');
const c         = require('../controllers/cannibalization.controller');

const router = express.Router();

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Слишком много задач за минуту. Подождите.' },
});
const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false,
});

router.post  ('/tasks',                 writeLimiter, auth, c.createTask);
router.get   ('/tasks',                 readLimiter,  auth, c.listTasks);
router.get   ('/tasks/:id',             readLimiter,  auth, c.getTask);
router.get   ('/tasks/:id/result',      readLimiter,  auth, c.getResult);
router.get   ('/tasks/:id/export.csv',  readLimiter,  auth, c.exportCsv);
router.get   ('/tasks/:id/export.xlsx', readLimiter,  auth, c.exportXlsx);
router.post  ('/tasks/:id/cancel',      writeLimiter, auth, c.cancelTask);
router.delete('/tasks/:id',             writeLimiter, auth, c.deleteTask);

module.exports = router;
