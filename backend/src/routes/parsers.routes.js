const express = require('express');
const router = express.Router();
const parsersController = require('../controllers/parsers.controller');
// const { authenticate } = require('../middleware/auth'); // If needed

router.post('/start', parsersController.startParsing);
router.get('/status/:taskId', parsersController.getTaskStatus);
router.get('/download/:taskId', parsersController.downloadReport);

module.exports = router;