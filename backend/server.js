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
const adminRoutes = require('./src/routes/admin.routes');

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
app.use('/api/admin', adminRoutes);

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
    // Диагностика: логируем, к какой БД подключаемся (без пароля)
    const dbUrl = process.env.DATABASE_URL;
    if (dbUrl) {
      try {
        const u = new URL(dbUrl);
        if (u.password) u.password = '***';
        console.log(`[DB] Connecting via DATABASE_URL: ${u.toString()}`);
      } catch {
        console.log('[DB] Connecting via DATABASE_URL (could not parse URL for logging)');
      }
    } else {
      const user = process.env.DB_USER || 'seogenius';
      const host = process.env.DB_HOST || 'localhost';
      const port = process.env.DB_PORT || '5432';
      const name = process.env.DB_NAME || 'seogenius_db';
      console.log(`[DB] Connecting via individual vars: ${user}@${host}:${port}/${name}`);
    }

    // Проверяем подключение к БД перед стартом
    await testConnection();

    // Применяем миграции, если нужно (idempotent)
    await ensureSchema();

    // Auto-seed администратора из ENV
    await seedAdmin();

    app.listen(PORT, () => {
      console.log(`[Server] SEO Genius v4.0 running on port ${PORT} [${process.env.NODE_ENV}]`);
    });
  } catch (err) {
    console.error('[Server] Failed to start:', err.message);
    process.exit(1);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime schema migrations (idempotent — safe to run on every startup)
// ─────────────────────────────────────────────────────────────────────────────

async function ensureSchema() {
  const db = require('./src/config/db');
  try {
    // Миграции в /docker-entrypoint-initdb.d применяются ТОЛЬКО при первом создании volume.
    // Если volume уже существует и были добавлены новые миграции (003+), их нужно
    // применить runtime. Все команды идемпотентны (IF NOT EXISTS).
    await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user' NOT NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)`);
    console.log('[Schema] ensureSchema OK');
  } catch (err) {
    console.warn(`[Schema] ensureSchema warning: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-seed admin account (ENV → hardcoded fallback)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_ADMIN_EMAIL    = 'targetlid1@yandex.ru';
const DEFAULT_ADMIN_PASSWORD = '1324354657Cfif';

async function seedAdmin() {
  const adminEmail    = process.env.ADMIN_EMAIL    || DEFAULT_ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;

  const db     = require('./src/config/db');
  const bcrypt = require('bcryptjs');
  const email  = adminEmail.toLowerCase().trim();

  try {
    // Проверяем, существует ли пользователь с указанным email
    const { rows: existing } = await db.query(
      `SELECT id, role, password_hash FROM users WHERE email = $1`,
      [email]
    );

    if (existing.length) {
      const user = existing[0];
      // Проверяем, совпадает ли текущий пароль
      const passwordMatch = await bcrypt.compare(adminPassword, user.password_hash);

      if (user.role === 'admin' && passwordMatch) {
        return; // Уже всё корректно
      }

      // Обновляем роль и/или пароль
      if (passwordMatch) {
        // Только роль нужно обновить
        await db.query(
          `UPDATE users SET role = 'admin' WHERE id = $1`,
          [user.id]
        );
      } else {
        // Обновляем и роль, и пароль
        const passwordHash = await bcrypt.hash(adminPassword, 12);
        await db.query(
          `UPDATE users SET role = 'admin', password_hash = $1 WHERE id = $2`,
          [passwordHash, user.id]
        );
      }
      console.log(`[Admin] Updated admin account: ${email}`);
    } else {
      // Создаём нового admin-пользователя
      const passwordHash = await bcrypt.hash(adminPassword, 12);
      await db.query(
        `INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, 'admin')`,
        [email, passwordHash, 'Administrator']
      );
      console.log(`[Admin] Auto-created admin account: ${email}`);
    }
  } catch (err) {
    // Не фатально — column может не существовать до миграции
    console.warn(`[Admin] Could not seed admin: ${err.message}`);
  }
}

start();

module.exports = app; // для тестов
