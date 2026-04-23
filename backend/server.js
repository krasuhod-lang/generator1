'use strict';

require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
// Hardcoded defaults — гарантируют работу даже без .env файла
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_JWT_SECRET = 'seogenius_jwt_secret_2024_kRas7xQ9';

if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = DEFAULT_JWT_SECRET;
  console.warn('[Config] ⚠ JWT_SECRET not set in environment — using built-in fallback. Set JWT_SECRET in .env for better security.');
}

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const path       = require('path');

const { testConnection } = require('./src/config/db');

const authRoutes  = require('./src/routes/auth.routes');
const tasksRoutes = require('./src/routes/tasks.routes');
const adminRoutes = require('./src/routes/admin.routes');
const editorCopilotRoutes = require('./src/routes/editorCopilot.routes');
const metaTagsRoutes      = require('./src/routes/metaTags.routes');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Доверяем первому прокси (nginx) — нужно для корректной работы
// express-rate-limit и определения реального IP через X-Forwarded-For
app.set('trust proxy', 1);

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
app.use('/api/editor-copilot', editorCopilotRoutes);
app.use('/api/meta-tags',      metaTagsRoutes);

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
    // Диагностика: критические переменные окружения
    console.log(`[Config] JWT_SECRET: ${process.env.JWT_SECRET === DEFAULT_JWT_SECRET ? 'built-in fallback' : 'custom (from env)'}`);
    console.log(`[Config] ADMIN_EMAIL: ${process.env.ADMIN_EMAIL || '(not set — will use default)'}`);
    console.log(`[Config] ADMIN_PASSWORD: ${process.env.ADMIN_PASSWORD ? '***set***' : '(not set — will use default)'}`);

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

    // После рестарта переводим зависшие meta-tag-задачи в error
    try {
      const { recoverStuckMetaTagTasks } = require('./src/services/metaTags/pipeline');
      await recoverStuckMetaTagTasks();
    } catch (err) {
      console.warn('[Server] Meta-tag recovery skipped:', err.message);
    }

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
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_target_url TEXT`);

    // Migration 005: pause/resume support — add 'pausing' / 'paused' to task_status enum,
    // add pipeline_checkpoint column, and partial index. Idempotent via DO blocks /
    // IF NOT EXISTS. Required because /docker-entrypoint-initdb.d migrations only run
    // on first volume creation, leaving existing deployments without these values
    // (causes "invalid input value for enum task_status: 'pausing'" on stop).
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'pausing'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'task_status')
        ) THEN
          ALTER TYPE task_status ADD VALUE 'pausing';
        END IF;
      END$$;
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_enum
          WHERE enumlabel = 'paused'
            AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'task_status')
        ) THEN
          ALTER TYPE task_status ADD VALUE 'paused';
        END IF;
      END$$;
    `);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pipeline_checkpoint JSONB`);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_pause_status
        ON tasks(status)
        WHERE status IN ('paused', 'pausing')
    `);

    // ─── Migration 006: Pre-Stage 0 strategic context + unused-inputs ──
    // Идемпотентно добавляем JSONB-колонки. Без `strategy_context`
    // contextBuilder AI-Copilot редактора падает на SELECT с ошибкой
    // `column "strategy_context" does not exist` (таблица была создана
    // до миграции 006 — initdb-миграции не применяются повторно).
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS strategy_context JSONB`);
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS unused_inputs    JSONB`);

    // ─── Migration 007: AI-Copilot редактор готовой статьи ───────────
    // Идемпотентно создаём ENUMs, таблицы editor_copilot_sessions /
    // editor_copilot_operations и колонку tasks.full_html_edited.
    // Без этих сущностей вкладка «AI-Редактор» во фронте не работает.
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS full_html_edited TEXT`);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'editor_copilot_action') THEN
          CREATE TYPE editor_copilot_action AS ENUM (
            'factcheck','add_faq','enrich_lsi','expand_section','anti_spam','custom'
          );
        END IF;
      END$$;
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'editor_copilot_status') THEN
          CREATE TYPE editor_copilot_status AS ENUM (
            'pending','streaming','done','error','cancelled'
          );
        END IF;
      END$$;
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'editor_copilot_apply_mode') THEN
          CREATE TYPE editor_copilot_apply_mode AS ENUM ('replace','insert_below');
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS editor_copilot_sessions (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        task_id           UUID UNIQUE NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        total_tokens_in   BIGINT      NOT NULL DEFAULT 0,
        total_tokens_out  BIGINT      NOT NULL DEFAULT 0,
        total_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_copilot_sessions_user_id ON editor_copilot_sessions(user_id)`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS editor_copilot_operations (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id      UUID NOT NULL REFERENCES editor_copilot_sessions(id) ON DELETE CASCADE,
        task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action          editor_copilot_action      NOT NULL,
        selected_text   TEXT,
        user_prompt     TEXT,
        extra_params    JSONB,
        status          editor_copilot_status      NOT NULL DEFAULT 'pending',
        result_text     TEXT,
        applied         BOOLEAN                    NOT NULL DEFAULT FALSE,
        applied_mode    editor_copilot_apply_mode,
        tokens_in       INTEGER                    NOT NULL DEFAULT 0,
        tokens_out      INTEGER                    NOT NULL DEFAULT 0,
        cost_usd        NUMERIC(12,6)              NOT NULL DEFAULT 0,
        model_used      TEXT,
        error_message   TEXT,
        logs            JSONB                      NOT NULL DEFAULT '[]'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at    TIMESTAMPTZ
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_copilot_ops_task_created ON editor_copilot_operations (task_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_copilot_ops_session ON editor_copilot_operations (session_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_copilot_ops_status ON editor_copilot_operations (status)`);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_copilot_sessions_updated_at') THEN
          CREATE TRIGGER trg_copilot_sessions_updated_at
            BEFORE UPDATE ON editor_copilot_sessions
            FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
        END IF;
      END$$;
    `);

    // ─── Migration 008: Bulk Meta-Tag Generator (DrMax v25) ──────────
    // Идемпотентно создаём ENUM meta_tag_task_status и таблицу
    // meta_tag_tasks (хранит входные параметры, ход и результаты bulk-
    // генерации Title+Description по списку ключей через XMLStock + Gemini).
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meta_tag_task_status') THEN
          CREATE TYPE meta_tag_task_status AS ENUM (
            'pending','in_progress','done','error','cancelled'
          );
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS meta_tag_tasks (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name             TEXT NOT NULL,
        niche            TEXT,
        lr               TEXT,
        toponym          TEXT,
        brand            TEXT,
        phone            TEXT,
        summary          TEXT,
        keywords         JSONB NOT NULL DEFAULT '[]'::jsonb,
        status           meta_tag_task_status NOT NULL DEFAULT 'pending',
        progress_current INTEGER NOT NULL DEFAULT 0,
        progress_total   INTEGER NOT NULL DEFAULT 0,
        active_keyword   TEXT,
        error_message    TEXT,
        results          JSONB NOT NULL DEFAULT '[]'::jsonb,
        logs             JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at       TIMESTAMPTZ,
        completed_at     TIMESTAMPTZ
      )
    `);
    // Идемпотентно добавляем колонки учёта токенов / стоимости (для существующих БД).
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS total_tokens_in  BIGINT NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS total_tokens_out BIGINT NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS total_cost_usd   NUMERIC(12, 6) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS llm_model        TEXT`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_user_created ON meta_tag_tasks (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_status ON meta_tag_tasks (status)`);

    // ─── Migration 010: LLM provider selection (Gemini | Grok) ───────
    // Идемпотентно добавляем колонку llm_provider во все таблицы, которые
    // запускают тяжёлые генеративные вызовы. Без этой колонки падают:
    //   • POST /api/meta-tags  → INSERT ... llm_provider
    //   • GET  /api/editor-copilot/* → SELECT ... llm_provider
    //   • запуск pipeline (tasks)
    // Whitelisted значения: 'gemini' | 'grok' (см. callLLM.js routing).
    await db.query(`ALTER TABLE tasks                     ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini'`);
    await db.query(`ALTER TABLE meta_tag_tasks            ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini'`);
    await db.query(`ALTER TABLE editor_copilot_sessions   ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini'`);
    await db.query(`ALTER TABLE editor_copilot_operations ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini'`);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'tasks_llm_provider_check'
        ) THEN
          ALTER TABLE tasks
            ADD CONSTRAINT tasks_llm_provider_check
            CHECK (llm_provider IN ('gemini', 'grok'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'meta_tag_tasks_llm_provider_check'
        ) THEN
          ALTER TABLE meta_tag_tasks
            ADD CONSTRAINT meta_tag_tasks_llm_provider_check
            CHECK (llm_provider IN ('gemini', 'grok'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'editor_copilot_sessions_llm_provider_check'
        ) THEN
          ALTER TABLE editor_copilot_sessions
            ADD CONSTRAINT editor_copilot_sessions_llm_provider_check
            CHECK (llm_provider IN ('gemini', 'grok'));
        END IF;

        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'editor_copilot_operations_llm_provider_check'
        ) THEN
          ALTER TABLE editor_copilot_operations
            ADD CONSTRAINT editor_copilot_operations_llm_provider_check
            CHECK (llm_provider IN ('gemini', 'grok'));
        END IF;
      END$$;
    `);

    console.log('[Schema] ensureSchema OK');
  } catch (err) {
    console.error(`[Schema] ensureSchema FAILED: ${err.message}`);
    throw err; // Критично — без role-колонки seedAdmin и admin-панель не работают
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

  console.log(`[Admin] Seeding admin account for: ${email} (source: ${process.env.ADMIN_EMAIL ? 'env' : 'default'})`);

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
        console.log(`[Admin] Admin account already up-to-date: ${email}`);
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

    // Верификация: убеждаемся, что admin действительно создан/обновлён
    const { rows: verify } = await db.query(
      `SELECT id, email, role FROM users WHERE email = $1 AND role = 'admin'`,
      [email]
    );
    if (!verify.length) {
      throw new Error(`Admin verification failed — user ${email} not found with role=admin after seed`);
    }
    console.log(`[Admin] Verified admin exists: ${verify[0].email} (id: ${verify[0].id})`);
  } catch (err) {
    console.error(`[Admin] FAILED to seed admin: ${err.message}`);
    throw err; // Критично — без admin-аккаунта панель управления не работает
  }
}

start();

module.exports = app; // для тестов
