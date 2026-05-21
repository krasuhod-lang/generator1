'use strict';

const express   = require('express');
const rateLimit = require('express-rate-limit');
const auth      = require('../middleware/auth');

const {
  getStatus,
  listBacklog,
  createBacklogItem,
  triggerDspyRetrain,
  proposeMutation,
  listRuns,
  listBrainVersions,
} = require('../controllers/aegis.controller');

const router = express.Router();

const readLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      120,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов к /api/aegis. Попробуйте позже.' },
});

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      20,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много модифицирующих запросов к /api/aegis.' },
});

router.use(readLimiter);

router.get('/status',          auth, getStatus);
router.get('/backlog',         auth, listBacklog);
router.post('/backlog',        auth, writeLimiter, createBacklogItem);
router.post('/dspy/retrain',   auth, writeLimiter, triggerDspyRetrain);
router.post('/mutate/propose', auth, writeLimiter, proposeMutation);
router.get('/runs',            auth, listRuns);
router.get('/brain/versions',  auth, listBrainVersions);

module.exports = router;
