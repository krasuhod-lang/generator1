const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const parsersController = require('../controllers/parsers.controller');
// const { authenticate } = require('../middleware/auth'); // If needed

const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Слишком много запросов на скачивание. Попробуйте позже.' },
});

router.post('/start', parsersController.startParsing);
router.get('/status/:taskId', parsersController.getTaskStatus);
router.get('/download/:taskId', downloadLimiter, parsersController.downloadReport);

module.exports = router;