'use strict';

require('dotenv').config();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const path       = require('path');

const { testConnection } = require('./src/config/db');

const authRoutes  = require('./src/routes/auth.routes');
const tasksRoutes = require('./src/routes/tasks.routes');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// -----------------------------------------------------------------
// Middleware
// -----------------------------------------------------------------

// Безопасность заголовков
app.use(helmet({
  // SSE требует отключить contentSecurityPolicy для dev-окружения
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? undefined : false,
}));

// CORS — разрешаем запросы от фронтенда
// allowedHeaders явно включает Authorization — иначе браузер блокирует preflight
const CORS_ORIGINS_DEV = [
  'http://localhost:5173',  // Vite default
  'http://localhost:8080',  // Vue CLI / docker
  'http://localhost:3000',  // если фронт на том же порту
  'http://localhost:80',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:8080',
];

app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL || 'http://localhost:80')
    : CORS_ORIGINS_DEV,
  credentials:    true,
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['Authorization'],
  methods:        ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
}));

// Явно обрабатываем OPTIONS preflight для SSE и остальных роутов
app.options('*', cors());

// Логирование HTTP-запросов
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Парсинг JSON и form-data
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Статические файлы для загрузок (DOCX и т.д.)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// -----------------------------------------------------------------
// Health check (не требует JWT)
// -----------------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    service: 'SEO Genius v4.0 Backend',
    time:    new Date().toISOString(),
    env:     process.env.NODE_ENV,
  });
});

// -----------------------------------------------------------------
// API Routes
// -----------------------------------------------------------------

app.use('/api/auth',  authRoutes);
app.use('/api/tasks', tasksRoutes);

// -----------------------------------------------------------------
// 404 handler
// -----------------------------------------------------------------

app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// -----------------------------------------------------------------
// Global error handler
// -----------------------------------------------------------------

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.stack || err.message);
  res.status(err.status || 500).json({
    error:   err.message || 'Internal Server Error',
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// -----------------------------------------------------------------
// Запуск сервера
// -----------------------------------------------------------------

const start = async () => {
  try {
    // Проверяем подключение к БД перед стартом
    await testConnection();

    app.listen(PORT, () => {
      console.log(`[Server] SEO Genius v4.0 running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
};

start();

module.exports = app; // для тестов
