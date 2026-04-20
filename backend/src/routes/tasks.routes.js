'use strict';

const express        = require('express');
const multer         = require('multer');
const path           = require('path');
const authMiddleware = require('../middleware/auth');
const {
  listTasks,
  createTask,
  getTask,
  updateTask,
  startTask,
  pauseTask,
  resumeTask,
  deleteTask,
  getResult,
  getMetrics,
  getBlocks,
  getStages,
  streamTask,
  uploadTZ,
  parseTZWithLLM,
  downloadExampleTZ,
} = require('../controllers/tasks.controller');

const jwt = require('jsonwebtoken');
const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// authSSE — для SSE-роута: принимает токен из ?token= query param
// (нативный EventSource не поддерживает заголовки)
// ─────────────────────────────────────────────────────────────────────────────
function authSSE(req, res, next) {
  // Сначала пробуем заголовок, потом query-параметр
  const authHeader = req.headers['authorization'];
  const token = (authHeader && authHeader.split(' ')[1]) || req.query.token;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: decoded.id, email: decoded.email };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Multer — загрузка DOCX файлов ТЗ
// ─────────────────────────────────────────────────────────────────────────────

const uploadDir = path.join(__dirname, '../../../uploads');

// Убеждаемся что папка существует при старте
const fs = require('fs');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename:    (req, file, cb) => {
    // taskId_timestamp.docx — уникально и безопасно
    const safe = file.originalname.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g, '_');
    cb(null, `${req.params.id}_${Date.now()}_${safe}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только .docx/.doc файлы'));
  },
});

// Multer для /parse-tz: принимает PDF, DOCX, TXT (без привязки к taskId)
const uploadTz = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename:    (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Zа-яА-ЯёЁ0-9._-]/g, '_');
      cb(null, `tz_${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    const allowed = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/msword',
      'text/plain',
    ];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Разрешены только .pdf, .docx, .doc, .txt файлы'));
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Роуты tasks — JWT обязателен для всех
// SSE /stream использует authSSE (поддерживает ?token= query param)
// ─────────────────────────────────────────────────────────────────────────────

// Коллекция задач
router.get('/',    authMiddleware, listTasks);   // GET  /api/tasks
router.post('/',   authMiddleware, createTask);  // POST /api/tasks

// Pre-Stage (-1): LLM-извлечение полей из ТЗ (ДОЛЖЕН быть ДО /:id)
router.post('/parse-tz', authMiddleware, uploadTz.single('file'), parseTZWithLLM); // POST /api/tasks/parse-tz

// Скачать пример ТЗ (DOCX) (ДОЛЖЕН быть ДО /:id)
router.get('/example-tz', authMiddleware, downloadExampleTZ); // GET /api/tasks/example-tz

// Конкретная задача
router.get('/:id',         authMiddleware, getTask);    // GET    /api/tasks/:id
router.patch('/:id',       authMiddleware, updateTask); // PATCH  /api/tasks/:id
router.delete('/:id',      authMiddleware, deleteTask); // DELETE /api/tasks/:id

// Действия над задачей
router.post('/:id/start',  authMiddleware, startTask);   // POST /api/tasks/:id/start
router.post('/:id/pause',  authMiddleware, pauseTask);   // POST /api/tasks/:id/pause
router.post('/:id/resume', authMiddleware, resumeTask);  // POST /api/tasks/:id/resume

// Результаты и данные
router.get('/:id/result',  authMiddleware, getResult);  // GET /api/tasks/:id/result
router.get('/:id/metrics', authMiddleware, getMetrics); // GET /api/tasks/:id/metrics
router.get('/:id/blocks',  authMiddleware, getBlocks);  // GET /api/tasks/:id/blocks
router.get('/:id/stages',  authMiddleware, getStages);  // GET /api/tasks/:id/stages

// SSE stream — authSSE принимает ?token= (EventSource не поддерживает заголовки)
router.get('/:id/stream',  authSSE, streamTask); // GET /api/tasks/:id/stream

// Загрузка DOCX файла ТЗ
router.post('/:id/upload-tz', authMiddleware, upload.single('file'), uploadTZ); // POST /api/tasks/:id/upload-tz

module.exports = router;
