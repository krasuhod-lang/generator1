const { Router } = require('express');
const multer = require('multer');
const path = require('path');
const { auth, authSSE } = require('../middleware/auth');
const tasksCtrl = require('../controllers/tasks.controller');

const router = Router();

// Multer config for TZ file uploads
const upload = multer({
  dest: path.resolve(__dirname, '../../uploads/'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.docx', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only .pdf, .docx, and .txt files are allowed'));
    }
  },
});

// --- TZ auto-fill (must be before /:id routes to avoid conflict) ---
router.post('/parse-tz', auth, upload.single('file'), tasksCtrl.parseTz);

// --- CRUD ---
router.post('/', auth, tasksCtrl.createTask);
router.get('/', auth, tasksCtrl.listTasks);
router.get('/:id', auth, tasksCtrl.getTask);
router.delete('/:id', auth, tasksCtrl.deleteTask);

// --- Pipeline ---
router.post('/:id/start', auth, tasksCtrl.startPipeline);

// --- SSE ---
router.get('/:id/sse', authSSE, tasksCtrl.sseStream);

module.exports = router;
