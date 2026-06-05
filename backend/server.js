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
const linkArticleRoutes   = require('./src/routes/linkArticle.routes');
const infoArticleRoutes   = require('./src/routes/infoArticle.routes');
const articleTopicsRoutes = require('./src/routes/articleTopics.routes');
const acfJsonRoutes       = require('./src/routes/acfJson.routes');
const relevanceRoutes     = require('./src/routes/relevance.routes');
const forecasterRoutes    = require('./src/routes/forecaster.routes');
const forecasterPublicRoutes = require('./src/routes/forecasterPublic.routes');
const projectsRoutes      = require('./src/routes/projects.routes');
const projectsPublicRoutes = require('./src/routes/projectsPublic.routes');
const aegisRoutes         = require('./src/routes/aegis.routes');
const categoryLeadRoutes  = require('./src/routes/categoryLead.routes');

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
app.use('/api/link-article',   linkArticleRoutes);
app.use('/api/info-article',   infoArticleRoutes);
app.use('/api/article-topics', articleTopicsRoutes);
app.use('/api/acf-json',       acfJsonRoutes);
app.use('/api/relevance',      relevanceRoutes);
app.use('/api/forecaster',     forecasterRoutes);
app.use('/api/public',         forecasterPublicRoutes);
app.use('/api/projects',       projectsRoutes);
app.use('/api/public',         projectsPublicRoutes);
app.use('/api/category-lead',  categoryLeadRoutes);
// Алиас OAuth-колбэка Google для совместимости с ранее настроенным в
// Google Cloud redirect_uri вида https://<домен>/api/oauth/google/callback.
// Канонический путь — /api/public/projects/gsc/callback. Лимитируем так же,
// как публичный роутер (60 req/min), чтобы не открывать нелимитированную точку.
const oauthAliasLimiter = require('express-rate-limit')({
  windowMs: 60 * 1000,
  max:      60,
  standardHeaders: true,
  legacyHeaders:   false,
  message: { error: 'Слишком много запросов. Попробуйте позже.' },
});
app.get('/api/oauth/google/callback',
  oauthAliasLimiter,
  require('./src/controllers/projects.controller').handleGscCallback);
// Алиас OAuth-колбэка Яндекса (симметрично Google) для совместимости с
// настроенным в Яндекс ID redirect_uri вида https://<домен>/api/oauth/yandex/callback.
app.get('/api/oauth/yandex/callback',
  oauthAliasLimiter,
  require('./src/controllers/projects.controller').handleYdxCallback);
app.use('/api/aegis',          aegisRoutes);

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

    // После рестарта переводим зависшие category-lead-задачи в error
    try {
      const { recoverStuckCategoryLeadTasks } = require('./src/services/categoryLead/pipeline');
      await recoverStuckCategoryLeadTasks();
    } catch (err) {
      console.warn('[Server] Category-lead recovery skipped:', err.message);
    }

    // После рестарта переводим зависшие link-article-задачи в error
    try {
      const { recoverStuckLinkArticleTasks } = require('./src/services/linkArticle/linkArticlePipeline');
      await recoverStuckLinkArticleTasks();
    } catch (err) {
      console.warn('[Server] Link-article recovery skipped:', err.message);
    }

    // После рестарта — то же для задач генератора тем статей.
    try {
      const { recoverStuckArticleTopicTasks } = require('./src/services/articleTopics/articleTopicsPipeline');
      await recoverStuckArticleTopicTasks();
    } catch (err) {
      console.warn('[Server] Article-topics recovery skipped:', err.message);
    }

    // После рестарта — то же для задач генератора инфо-статьи в блог.
    try {
      const { recoverStuckInfoArticleTasks } = require('./src/services/infoArticle/infoArticlePipeline');
      await recoverStuckInfoArticleTasks();
    } catch (err) {
      console.warn('[Server] Info-article recovery skipped:', err.message);
    }

    // A.E.G.I.S. Phase 9–13: bootstrap kill switch state + wire alerting → db.
    try {
      const db          = require('./src/config/db');
      const killSwitch  = require('./src/services/aegis/killSwitch');
      const alerting    = require('./src/services/aegis/alerting');
      const telemetry   = require('./src/services/aegis/telemetry');
      const { getAegisFlags } = require('./src/services/aegis/featureFlags');
      const { startBacklogWorker } = require('./src/services/aegis/backlogWorker');
      alerting.setDbConnection(db);
      await killSwitch.loadInitialState(db);
      telemetry.startOtlpPusher(); // no-op если AEGIS_OTLP_HTTP_URL пуст.
      const b = getAegisFlags().backlog;
      if (b.enabled && b.repo && b.pat) startBacklogWorker();

      // Phase 16 — autopilot для «компилированного мозга».
      // dspyAutoRetrain.startDspyAutoRetrain сам гейтится по dspy.enabled и
      // dspy.autoRetrainEnabled (см. featureFlags.dspy). Без ENV — это
      // безопасно: если dspy.enabled=false, воркер ничего не делает,
      // только заполняет telemetry для /api/aegis/status.
      try {
        const { startDspyAutoRetrain } = require('./src/services/aegis/dspyAutoRetrain');
        startDspyAutoRetrain();
      } catch (e) {
        console.warn('[Server] AEGIS dspyAutoRetrain skipped:', e.message);
      }
      try {
        const { startSeoBrainScheduler } = require('./src/services/aegis/seoBrainScheduler');
        startSeoBrainScheduler();
      } catch (e) {
        console.warn('[Server] AEGIS seoBrainScheduler skipped:', e.message);
      }
      // 🧬 Bio-Brain — наблюдатель за автономным самообучаемым мозгом.
      // Сам мозг эволюционирует внутри aegis_py; здесь лишь снимаем
      // телеметрию для /api/aegis/status. Гейтится biobrain.enabled.
      try {
        const sched = require('./src/services/aegis/biobrainScheduler');
        // Прокидываем pg-pool, чтобы tick синхронизировал /biobrain/generations
        // с таблицей aegis_biobrain_versions (B6).
        try { sched.setDbConnection(db); } catch (_) {}
        sched.startBiobrainScheduler();
      } catch (e) {
        console.warn('[Server] AEGIS biobrainScheduler skipped:', e.message);
      }
      // 🌐 AlgoWatcher — RSS-наблюдатель за апдейтами поисковых алгоритмов.
      try {
        const aw = require('./src/services/aegis/algoWatcher');
        aw.setDbConnection(db);
        aw.startAlgoWatcher();
      } catch (e) {
        console.warn('[Server] AEGIS algoWatcher skipped:', e.message);
      }
      // 🎯 SERP outcome tracker — хранилище публикаций для замыкания петли B1.
      try {
        const t = require('./src/services/aegis/serpOutcomeTracker');
        t.setDbConnection(db);
      } catch (e) {
        console.warn('[Server] AEGIS serpOutcomeTracker skipped:', e.message);
      }
      // 🧪 Experiments loop (B4) — мозг сам ставит себе эксперименты:
      // entropy-sampling страниц + гипотеза → планирует эксперимент,
      // через measureAfterDays закрывает с reward в biobrain.feedback.
      try {
        const exp = require('./src/services/aegis/experimentLoop');
        exp.setDbConnection(db);
        exp.startExperimentLoop();
      } catch (e) {
        console.warn('[Server] AEGIS experimentLoop skipped:', e.message);
      }
    } catch (err) {
      console.warn('[Server] A.E.G.I.S. observability bootstrap skipped:', err.message);
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
    await db.query(`ALTER TABLE tasks ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview'`);

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
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS gemini_model     TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview'`);
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS source           TEXT`);
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER`);
    // Migration 053: source_relevance_report_id для meta_tag_tasks
    // (Sprint B). При наличии — pipeline загрузит relevance-артефакт и
    // вольёт LSI/n-граммы в per-keyword промпт generateDrMaxMeta.
    await db.query(`ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID`);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_relevance_src
        ON meta_tag_tasks (source_relevance_report_id)
        WHERE source_relevance_report_id IS NOT NULL
    `);
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
    // ─── Migration 012: Link Article Generator ───────────────────────
    // Генератор ссылочной статьи. Отдельный пайплайн и таблица.
    // Создаём ENUM и таблицу идемпотентно, чтобы после простого
    // pull + restart контейнера всё заработало без ручного psql.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_article_status') THEN
          CREATE TYPE link_article_status AS ENUM (
            'queued', 'running', 'done', 'error'
          );
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS link_article_tasks (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic               TEXT NOT NULL,
        anchor_text         TEXT NOT NULL,
        anchor_url          TEXT NOT NULL,
        focus_notes         TEXT,
        output_format       VARCHAR(16) NOT NULL DEFAULT 'html',
        status              link_article_status NOT NULL DEFAULT 'queued',
        progress_pct        INTEGER NOT NULL DEFAULT 0,
        current_stage       TEXT,
        error_message       TEXT,
        strategy_context    JSONB,
        stage0_audience     JSONB,
        stage1_intents      JSONB,
        stage2_structure    JSONB,
        article_html        TEXT,
        article_plain       TEXT,
        image_prompts       JSONB NOT NULL DEFAULT '[]'::jsonb,
        deepseek_tokens_in  BIGINT NOT NULL DEFAULT 0,
        deepseek_tokens_out BIGINT NOT NULL DEFAULT 0,
        gemini_tokens_in    BIGINT NOT NULL DEFAULT 0,
        gemini_tokens_out   BIGINT NOT NULL DEFAULT 0,
        gemini_image_calls  INTEGER NOT NULL DEFAULT 0,
        cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
        logs                JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at          TIMESTAMPTZ,
        completed_at        TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_link_article_user_created ON link_article_tasks (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_link_article_status       ON link_article_tasks (status)`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview'`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS source TEXT`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER`);

    // Отдельный журнал событий пайплайна ссылочной статьи.
    // Inline logs JSONB в link_article_tasks остаётся для UI-ленты,
    // а эта таблица — для ретроспективного аудита и админ-панели.
    await db.query(`
      CREATE TABLE IF NOT EXISTS link_article_events (
        id         BIGSERIAL PRIMARY KEY,
        task_id    UUID NOT NULL REFERENCES link_article_tasks(id) ON DELETE CASCADE,
        stage      TEXT,
        level      VARCHAR(8) NOT NULL DEFAULT 'info',
        message    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_link_article_events_task_time ON link_article_events (task_id, created_at)`);

    // ─── Migration 013: Link Article Generator — Enhancements ────────
    // Идемпотентно добавляем колонки для:
    //   - whitespace_analysis: новый Stage 1B (white-space discovery, DeepSeek);
    //   - eeat_audit / eeat_score: Stage 5 E-E-A-T audit (DeepSeek);
    //   - gemini_cache_name: имя Gemini cachedContents (LAKB-кэш для Gemini).
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS whitespace_analysis JSONB`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS eeat_audit          JSONB`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS eeat_score          NUMERIC(4, 2)`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS gemini_cache_name   TEXT`);
    // Migration 053: source_relevance_report_id (Sprint B — Relevance →
    // generators). Привязывает задачу ссылочной статьи к отчёту
    // релевантности; pipeline подгружает relevance-артефакт и инжектит
    // LSI/n-граммы/H2-H3 наброски в writer.
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID`);
    // Migration 060: SEO/GEO 2026 — JSON-LD blocks + author byline для ссылочных статей.
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS article_html_with_schema TEXT`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS json_ld_blocks           JSONB`);
    await db.query(`ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS author_byline            TEXT`);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_link_article_tasks_relevance_src
        ON link_article_tasks (source_relevance_report_id)
        WHERE source_relevance_report_id IS NOT NULL
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_link_article_eeat_score
        ON link_article_tasks (eeat_score)
        WHERE eeat_score IS NOT NULL
    `);

    // ─── Migration 015: Article Topic Forecaster (Темы статей) ───────
    // Foresight-генератор тем статей. Один Gemini-вызов → markdown-отчёт.
    // Поддерживается main / deep_dive (deep_dive ссылается на main).
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'article_topic_status') THEN
          CREATE TYPE article_topic_status AS ENUM ('queued', 'running', 'done', 'error');
        END IF;
      END$$;
    `);
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'article_topic_mode') THEN
          CREATE TYPE article_topic_mode AS ENUM ('main', 'deep_dive');
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS article_topic_tasks (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        mode              article_topic_mode NOT NULL DEFAULT 'main',
        parent_task_id    UUID REFERENCES article_topic_tasks(id) ON DELETE SET NULL,
        niche             TEXT NOT NULL,
        region            TEXT NOT NULL DEFAULT '',
        horizon           TEXT NOT NULL DEFAULT '',
        audience          TEXT NOT NULL DEFAULT '',
        market_stage      TEXT NOT NULL DEFAULT '',
        search_ecosystem  TEXT NOT NULL DEFAULT '',
        top_competitors   TEXT NOT NULL DEFAULT '',
        trend_name        TEXT,
        status            article_topic_status NOT NULL DEFAULT 'queued',
        error_message     TEXT,
        result_markdown   TEXT,
        llm_model         TEXT,
        gemini_tokens_in  BIGINT NOT NULL DEFAULT 0,
        gemini_tokens_out BIGINT NOT NULL DEFAULT 0,
        cost_usd          NUMERIC(12, 6) NOT NULL DEFAULT 0,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ,
        updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topic_user_created ON article_topic_tasks (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topic_status       ON article_topic_tasks (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topic_parent       ON article_topic_tasks (parent_task_id) WHERE parent_task_id IS NOT NULL`);

    // Migration 051: brand history для дедупа тем по бренду.
    // pg_trgm может не подняться на managed Postgres без superuser — гасим
    // ошибку, тогда detector использует только exact + Jaccard prefilter.
    try {
      await db.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    } catch (e) {
      console.warn('[ensureSchema] pg_trgm extension not available (brand dedup degrades to exact/Jaccard only):', e.message);
    }
    await db.query(`
      CREATE TABLE IF NOT EXISTS article_topics_brand_history (
        id                  BIGSERIAL    PRIMARY KEY,
        user_id             UUID         NOT NULL,
        brand_key           TEXT         NOT NULL,
        topic_title_canon   TEXT         NOT NULL,
        topic_h1_canon      TEXT,
        primary_intent      TEXT,
        intent_facet        TEXT,
        topic_idea_task_id  UUID         REFERENCES article_topic_tasks(id) ON DELETE SET NULL,
        created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, brand_key, topic_title_canon)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topics_brand_history_userbrand ON article_topics_brand_history (user_id, brand_key)`);
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topics_brand_history_title_trgm ON article_topics_brand_history USING GIN (topic_title_canon gin_trgm_ops)`);
    } catch (e) {
      console.warn('[ensureSchema] trigram GIN index skipped:', e.message);
    }
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topics_brand_history_created ON article_topics_brand_history (created_at DESC)`);

    // Migration 052: brand aliases + semantic fingerprint.
    // Алиасы позволяют склеивать разные написания одного бренда
    // («Бренд Х», «brand-x», «BrandX Pro») в один canonical brand_key.
    await db.query(`
      CREATE TABLE IF NOT EXISTS article_topics_brand_aliases (
        id                    BIGSERIAL    PRIMARY KEY,
        user_id               UUID         NOT NULL,
        brand_key_canonical   TEXT         NOT NULL,
        brand_alias_key       TEXT         NOT NULL,
        source                TEXT         NOT NULL DEFAULT 'manual',
        confidence            REAL,
        created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (user_id, brand_alias_key)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_brand_aliases_user_canonical ON article_topics_brand_aliases (user_id, brand_key_canonical)`);
    await db.query(`ALTER TABLE article_topics_brand_history ADD COLUMN IF NOT EXISTS semantic_fingerprint JSONB`);

    // ─── Migration 016: Article Topics — enhancements (plan B/C) ──────
    // Добавляем JSONB-колонки для structured trends, evaluator-отчёта и
    // снимка module-context. Создаём реестр трендов для дедупа и
    // cross-niche инсайтов. Все команды идемпотентны.
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS trends_json         JSONB`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS evaluator_report    JSONB`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS module_context_used JSONB`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS gemini_model        TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview'`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS source TEXT`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS article_topic_trends (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID NOT NULL REFERENCES users(id)               ON DELETE CASCADE,
        task_id         UUID NOT NULL REFERENCES article_topic_tasks(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        niche           TEXT NOT NULL DEFAULT '',
        stage           TEXT,
        confidence      TEXT,
        drivers         JSONB DEFAULT '[]'::jsonb,
        signal_ids      JSONB DEFAULT '[]'::jsonb,
        vector          TEXT,
        competitor_coverage TEXT,
        window_months   INTEGER DEFAULT 0,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topic_trends_user_norm  ON article_topic_trends (user_id, normalized_name, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topic_trends_task       ON article_topic_trends (task_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_article_topic_trends_user_niche ON article_topic_trends (user_id, niche, normalized_name)`);

    // ─── Migration 029: Article Topics — Idea-mode (Подбор тем статей) ──
    // Третий режим задачи: 'topic_ideas' — анализ рынка/сущностей/интентов,
    // ровно N предложенных тем, описание ЦА и список фактов о бренде/нише.
    // Колонки additive-only, чтобы старые задачи main/deep_dive не пострадали.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_type t
            JOIN pg_enum e ON t.oid = e.enumtypid
           WHERE t.typname = 'article_topic_mode'
             AND e.enumlabel = 'topic_ideas'
        ) THEN
          ALTER TYPE article_topic_mode ADD VALUE 'topic_ideas';
        END IF;
      END$$;
    `);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS topic_count_requested INT`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS topic_count_returned  INT`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS topic_ideas_json      JSONB`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS audience_profile      JSONB`);
    await db.query(`ALTER TABLE article_topic_tasks ADD COLUMN IF NOT EXISTS brand_facts_json      JSONB`);

    // ─── Migration 017: Info Article Generator (Статья в блог) ────────
    // Информационная статья на основе Excel'я коммерческих страниц с
    // семантической перелинковкой 1–2 ссылок на каждый <h2>. Все DDL
    // идемпотентны — выполняются на каждый старт сервера.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'info_article_status') THEN
          CREATE TYPE info_article_status AS ENUM ('queued', 'running', 'done', 'error');
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS info_article_tasks (
        id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        topic                       TEXT NOT NULL,
        region                      TEXT NOT NULL DEFAULT '',
        brand_name                  TEXT,
        author_name                 TEXT,
        brand_facts                 TEXT,
        output_format               VARCHAR(16) NOT NULL DEFAULT 'html',
        commercial_links            JSONB NOT NULL DEFAULT '[]'::jsonb,
        commercial_links_filename   TEXT,
        commercial_links_count      INTEGER NOT NULL DEFAULT 0,
        status                      info_article_status NOT NULL DEFAULT 'queued',
        progress_pct                INTEGER NOT NULL DEFAULT 0,
        current_stage               TEXT,
        error_message               TEXT,
        strategy_context            JSONB,
        stage0_audience             JSONB,
        stage1_intents              JSONB,
        whitespace_analysis         JSONB,
        stage2_outline              JSONB,
        lsi_set                     JSONB,
        link_plan                   JSONB,
        link_plan_meta              JSONB,
        link_audit                  JSONB,
        eeat_report                 JSONB,
        eeat_score                  NUMERIC(4, 2),
        article_html                TEXT,
        article_plain               TEXT,
        image_prompts               JSONB NOT NULL DEFAULT '[]'::jsonb,
        gemini_cache_name           TEXT,
        deepseek_tokens_in          BIGINT NOT NULL DEFAULT 0,
        deepseek_tokens_out         BIGINT NOT NULL DEFAULT 0,
        gemini_tokens_in            BIGINT NOT NULL DEFAULT 0,
        gemini_tokens_out           BIGINT NOT NULL DEFAULT 0,
        gemini_image_calls          INTEGER NOT NULL DEFAULT 0,
        cost_usd                    NUMERIC(12, 6) NOT NULL DEFAULT 0,
        logs                        JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at                  TIMESTAMPTZ,
        completed_at                TIMESTAMPTZ,
        updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_info_article_user_created ON info_article_tasks (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_info_article_status       ON info_article_tasks (status)`);
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview'`);
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS source TEXT`);
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER`);
    // Migration 057: SEO-метатеги, генерируемые ИИ для статьи в блог.
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS seo_title       TEXT`);
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS seo_description TEXT`);
    // Migration 060: SEO/GEO 2026 — JSON-LD blocks + author byline.
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS article_html_with_schema TEXT`);
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS json_ld_blocks           JSONB`);
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS author_byline            TEXT`);
    // Migration 072: audience_research JSONB — A/B-телеметрия слоя §10
    // (Reddit Mapper V2 «голос аудитории»): бакет test/control, has_signal,
    // signal_count, stages_run, skipped_reason. Для офлайн-сравнения качества.
    await db.query(`ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS audience_research        JSONB`);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_info_article_eeat_score
        ON info_article_tasks (eeat_score)
        WHERE eeat_score IS NOT NULL
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS info_article_events (
        id         BIGSERIAL PRIMARY KEY,
        task_id    UUID NOT NULL REFERENCES info_article_tasks(id) ON DELETE CASCADE,
        stage      TEXT,
        level      VARCHAR(8) NOT NULL DEFAULT 'info',
        message    TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_info_article_events_task_time ON info_article_events (task_id, created_at)`);

    // ─── Migration 009: Persistent monitoring logs (task_logs) ────────
    // Хранит SSE-события задач для MonitorPage / админки. Без этой таблицы
    // taskLogPersister молча роняет батчи, а GET /api/tasks/:id/logs отдаёт
    // 500 ('relation "task_logs" does not exist'). DDL идемпотентен —
    // безопасно выполнять на каждый старт (см. migrations/009_add_task_logs.sql).
    await db.query(`
      CREATE TABLE IF NOT EXISTS task_logs (
        id           BIGSERIAL PRIMARY KEY,
        task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level        VARCHAR(16) NOT NULL DEFAULT 'info',
        stage        VARCHAR(32),
        event_type   VARCHAR(32) NOT NULL DEFAULT 'log',
        message      TEXT,
        payload      JSONB
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_task_logs_task_ts ON task_logs (task_id, ts)`);

    // ─── Migration 018: Relevance Analyzer (XMLStock SERP + BM25 + n-grams) ───
    // Хранит отчёты анализа релевантности (вкладка «Релевантность»). Сырой
    // текст ТОП-20 НЕ кладём — только агрегаты (BM25-словарь и n-граммы).
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'relevance_report_status') THEN
          CREATE TYPE relevance_report_status AS ENUM (
            'pending', 'fetching', 'analyzing', 'done', 'error'
          );
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS relevance_reports (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        query           TEXT NOT NULL,
        lr              TEXT NOT NULL DEFAULT '213',
        top_n           INTEGER NOT NULL DEFAULT 20,
        status          relevance_report_status NOT NULL DEFAULT 'pending',
        error_message   TEXT,
        current_stage   TEXT,
        serp            JSONB NOT NULL DEFAULT '[]'::jsonb,
        fetched_count   INTEGER NOT NULL DEFAULT 0,
        failed_urls     JSONB NOT NULL DEFAULT '[]'::jsonb,
        report          JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at      TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        duration_ms     INTEGER
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_relevance_reports_user_created ON relevance_reports (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_relevance_reports_status ON relevance_reports (status)`);
    await db.query(`ALTER TABLE relevance_reports ADD COLUMN IF NOT EXISTS source TEXT`);
    await db.query(`ALTER TABLE relevance_reports ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER`);

    // Migration 019: семантические коконы (SVD) + метаданные raw-кэша Redis.
    // processed_documents (леммы + POS-последовательности) живут в Redis
    // по ключу relevance:raw:{id} с TTL (default 7 дней) — Postgres хранит
    // только агрегаты + указатель на наличие/срок жизни кэша.
    await db.query(`
      ALTER TABLE relevance_reports
        ADD COLUMN IF NOT EXISTS cocoons         JSONB,
        ADD COLUMN IF NOT EXISTS raw_storage     TEXT DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS raw_expires_at  TIMESTAMPTZ
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_relevance_reports_raw_alive
        ON relevance_reports (raw_expires_at)
       WHERE raw_storage = 'redis' AND raw_expires_at IS NOT NULL
    `);

    // Migration 020: DB-fallback for processed_documents (леммы), чтобы
    // семантические коконы пересчитывались даже без Redis-кэша.
    // Без этой колонки relevance.controller / pipeline падают с
    // `column "raw_processed" does not exist` на существующих инсталляциях,
    // где /docker-entrypoint-initdb.d миграции уже не применяются.
    await db.query(`
      ALTER TABLE relevance_reports
        ADD COLUMN IF NOT EXISTS raw_processed JSONB
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_relevance_reports_raw_processed_present
        ON relevance_reports (id)
        WHERE raw_processed IS NOT NULL
    `);

    // Migration 021: «наш сайт vs ТОП конкурентов» — опциональное сравнение.
    //   our_url             — URL нашей страницы (input от пользователя);
    //   our_report          — diagnostics + leммы нашего документа;
    //   comparison          — итог /compare (per-term gap, lsi%, bm25, cos,
    //                         математические директивы, competitor table);
    //   exclude_aggregators — чекбокс «исключить агрегаторы из ТОПа».
    // Все поля nullable: на старых отчётах останутся NULL, фронт показывает
    // секцию сравнения только если comparison IS NOT NULL.
    await db.query(`
      ALTER TABLE relevance_reports
        ADD COLUMN IF NOT EXISTS our_url             TEXT,
        ADD COLUMN IF NOT EXISTS our_report          JSONB,
        ADD COLUMN IF NOT EXISTS comparison          JSONB,
        ADD COLUMN IF NOT EXISTS exclude_aggregators BOOLEAN NOT NULL DEFAULT FALSE
    `);

    // ─── Migration 031: relevance.cocoon_plan (Bourrelly cocoon) ─────────
    // План «семантического кокона» нашего будущего сайта (Page Cible →
    // Mères → Filles + золотые правила перелинковки). Хранится отдельно
    // от cocoons (TruncatedSVD/LSA по чужим документам) — это
    // принципиально другой контракт. Структура:
    //   { generated_at, duration_ms, options, plan, markdown }
    await db.query(`
      ALTER TABLE relevance_reports
        ADD COLUMN IF NOT EXISTS cocoon_plan JSONB
    `);

    // ─── Migration 022: relevance → content bridge + images_count ─────────
    // 1) Связь tasks/info_article_tasks с исходным relevance_report — чтобы
    //    pipeline вливал mandatory_entities + competitor_signals в
    //    __moduleContext (см. backend/src/utils/moduleContext.js) и в IAKB §9
    //    (backend/src/services/infoArticle/infoArticleKnowledgeBase.js).
    // 2) Управляемое пользователем количество изображений для info-article
    //    (бизнес-требование «делается только для статьи в блог»).
    await db.query(`
      ALTER TABLE tasks
        ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID
          REFERENCES relevance_reports(id) ON DELETE SET NULL
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_tasks_source_relevance
        ON tasks (source_relevance_report_id)
        WHERE source_relevance_report_id IS NOT NULL
    `);
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID
          REFERENCES relevance_reports(id) ON DELETE SET NULL,
        ADD COLUMN IF NOT EXISTS images_count INTEGER NOT NULL DEFAULT 1
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_info_article_source_relevance
        ON info_article_tasks (source_relevance_report_id)
        WHERE source_relevance_report_id IS NOT NULL
    `);
    // Защитный CHECK: 0..6 изображений. 0 — «Не нужны изображения»
    // (pipeline целиком пропускает Stage 4 и генерацию картинок). Выше 6
    // штучного количества pipeline не пойдёт. См. миграцию 056.
    // Drop+recreate, чтобы обновить старый constraint 1..6 (миграция 022).
    await db.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'info_article_tasks_images_count_chk'
        ) THEN
          ALTER TABLE info_article_tasks
            DROP CONSTRAINT info_article_tasks_images_count_chk;
        END IF;
        ALTER TABLE info_article_tasks
          ADD CONSTRAINT info_article_tasks_images_count_chk
          CHECK (images_count BETWEEN 0 AND 6);
      END$$;
    `);

    // Migration 023: хранилище fact-check отчёта (Phase 1 / P0-1).
    // Колонка nullable, не ломает старые задачи и пайплайны без grounding'а.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS fact_check_report JSONB;
    `);

    // Migration 024: хранилище plagiarism-отчёта (Phase 1 / P0-3).
    // Колонка nullable, не ломает старые задачи и пайплайны без grounding'а.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS plagiarism_report JSONB;
    `);

    // Migration 025: хранилище image-QA отчёта (Phase 1 / P0-4).
    // Колонка nullable: если INFO_ARTICLE_IMAGE_QA_ENABLED=false или картинок
    // не было — поле остаётся NULL. Не ломает старые задачи.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS image_qa_report JSONB;
    `);

    // Migration 026: хранилище readability-отчёта (Phase 2 / Б4).
    // Колонка nullable; если INFO_ARTICLE_READABILITY_ENABLED=false или
    // статья слишком короткая — поле остаётся NULL. Не ломает старые задачи.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS readability_report JSONB;
    `);

    // Migration 027: хранилище intent-verify отчёта (Phase 2 / Б5).
    // Колонка nullable; verdict=na при отсутствии competitor_signals.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS intent_verdict JSONB;
    `);

    // Migration 028: хранилище validation-tracker отчёта (Phase 2 / С1).
    // Колонка nullable; содержит per-pass issue-списки и by_kind tally
    // для последующей аналитики корпуса задач.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS validation_report JSONB;
    `);

    // Migration 030: lsi_overdose_report (anti-spam LSI density per-H2).
    // См. backend/src/services/infoArticle/lsiDensity.service.js.
    // Колонка nullable; для исторических задач остаётся NULL.
    await db.query(`
      ALTER TABLE info_article_tasks
        ADD COLUMN IF NOT EXISTS lsi_overdose_report JSONB;
    `);

    // Migration 037: quality_score JSONB — детерминированный агрегат качества
    // генерации, считаемый qualityLayers/qualityScore.js по уже существующим
    // отчётам (eeat, readability, intent, fact_check, plagiarism, lsi*, image_qa,
    // validation). Используется в /api/admin/model-comparison и в qualityFeedback.
    await db.query(`
      ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS quality_score JSONB;
    `);
    await db.query(`
      ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS quality_score JSONB;
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS info_article_quality_score_model_idx
        ON info_article_tasks ((quality_score->>'model_used'))
        WHERE quality_score IS NOT NULL;
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS link_article_quality_score_model_idx
        ON link_article_tasks ((quality_score->>'model_used'))
        WHERE quality_score IS NOT NULL;
    `);

    // Migration 054: generation_funnels — учёт успешных/неуспешных «связок»
    // (стадий) каждой генерации. Детализация каждой воронки + агрегаты для
    // анализа (conversion-rate, причины отказов, стоимость/латентность).
    // Пишется aegis/funnelTracker.persist() при включённом флаге funnel.persist.
    await db.query(`
      CREATE TABLE IF NOT EXISTS generation_funnels (
        id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
        kind              VARCHAR(32)   NOT NULL,
        task_ref          TEXT,
        user_id           UUID,
        niche             TEXT,
        status            VARCHAR(16)   NOT NULL DEFAULT 'completed',
        final_stage       TEXT,
        fail_reason       VARCHAR(48),
        stage_count       INTEGER       NOT NULL DEFAULT 0,
        total_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
        total_tokens_in   BIGINT        NOT NULL DEFAULT 0,
        total_tokens_out  BIGINT        NOT NULL DEFAULT 0,
        total_retries     INTEGER       NOT NULL DEFAULT 0,
        duration_ms       BIGINT        NOT NULL DEFAULT 0,
        report            JSONB,
        created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
        finished_at       TIMESTAMPTZ
      );
    `);
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS generation_funnels_kind_ref_uidx
        ON generation_funnels (kind, task_ref)
        WHERE task_ref IS NOT NULL;
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS generation_funnels_kind_created_idx
        ON generation_funnels (kind, created_at DESC);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS generation_funnels_status_idx
        ON generation_funnels (status);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS generation_funnels_fail_reason_idx
        ON generation_funnels (fail_reason)
        WHERE fail_reason IS NOT NULL;
    `);

    // ─── Migration 055: AEGIS LLM usage log ──────────────────────────────
    // Посуточный учёт расходов Эгиды: одна строка на LLM-вызов через
    // aegis/llmRouter (provider/kind/tokens/cached/cost/cache_hit/outcome).
    // Источник для admin-раздела «Расходы Эгиды по дням»
    // (GET /api/admin/aegis-costs). Пишется best-effort aegis/llmUsageLog.
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_llm_usage (
        id             BIGSERIAL     PRIMARY KEY,
        provider       VARCHAR(32)   NOT NULL,
        kind           VARCHAR(32),
        outcome        VARCHAR(16)   NOT NULL DEFAULT 'ok',
        tokens_in      BIGINT        NOT NULL DEFAULT 0,
        tokens_out     BIGINT        NOT NULL DEFAULT 0,
        cached_tokens  BIGINT        NOT NULL DEFAULT 0,
        cost_usd       NUMERIC(14,6) NOT NULL DEFAULT 0,
        cache_hit      BOOLEAN       NOT NULL DEFAULT FALSE,
        latency_ms     INTEGER,
        created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS aegis_llm_usage_created_idx
        ON aegis_llm_usage (created_at DESC);
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS aegis_llm_usage_provider_created_idx
        ON aegis_llm_usage (provider, created_at DESC);
    `);

    // Gemini text model selector for copywriting tasks: only internal
    // production-approved models are accepted per task.
    await db.query(`
      DO $$
      DECLARE
        tbl TEXT;
        constraint_name TEXT;
      BEGIN
        FOREACH tbl IN ARRAY ARRAY['tasks','meta_tag_tasks','link_article_tasks','info_article_tasks','article_topic_tasks']
        LOOP
          constraint_name := tbl || '_gemini_model_check';
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = constraint_name
          ) THEN
            EXECUTE format(
              'ALTER TABLE %I ADD CONSTRAINT %I CHECK (gemini_model IN (%L, %L))',
              tbl,
              constraint_name,
              'gemini-3.1-pro-preview',
              'gemini-3.5-flash'
            );
          END IF;
        END LOOP;
      END$$;
    `);

    // Migration 032: forecaster_tasks (модуль «Прогнозатор»).
    // Хранит загруженные CSV/XLSX-выгрузки Wordstat, агрегированный
    // помесячный спрос, найденные аномалии, прогноз на 12 мес,
    // оценку трафика для ТОП-3/5/10, выводы DeepSeek и share-токен.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'forecaster_status') THEN
          CREATE TYPE forecaster_status AS ENUM (
            'queued', 'running', 'done', 'error'
          );
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS forecaster_tasks (
        id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                TEXT NOT NULL DEFAULT '',
        status              forecaster_status NOT NULL DEFAULT 'queued',
        error_message       TEXT,
        source_filename     TEXT NOT NULL DEFAULT '',
        source_rows_count   INTEGER NOT NULL DEFAULT 0,
        source_columns      JSONB,
        options             JSONB,
        monthly_series      JSONB,
        anomalies           JSONB,
        forecast            JSONB,
        trend               JSONB,
        traffic_estimate    JSONB,
        deepseek_summary    JSONB,
        llm_provider        VARCHAR(16) NOT NULL DEFAULT 'deepseek',
        llm_model           TEXT,
        tokens_in           BIGINT NOT NULL DEFAULT 0,
        tokens_out          BIGINT NOT NULL DEFAULT 0,
        cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,
        share_token         TEXT UNIQUE,
        share_created_at    TIMESTAMPTZ,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at          TIMESTAMPTZ,
        completed_at        TIMESTAMPTZ,
        updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_forecaster_user_created ON forecaster_tasks (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_forecaster_status       ON forecaster_tasks (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_forecaster_share_token  ON forecaster_tasks (share_token) WHERE share_token IS NOT NULL`);

    // Migration 033: target_url + junk_phrases (см. файл миграции).
    await db.query(`ALTER TABLE forecaster_tasks ADD COLUMN IF NOT EXISTS target_url   TEXT`);
    await db.query(`ALTER TABLE forecaster_tasks ADD COLUMN IF NOT EXISTS junk_phrases JSONB`);

    // Migration 034: keysso_signals (интеграция keys.so).
    await db.query(`ALTER TABLE forecaster_tasks ADD COLUMN IF NOT EXISTS keysso_signals JSONB`);

    // Migration 035: advanced analytics (opportunities + DSPy experts + leads).
    await db.query(`ALTER TABLE forecaster_tasks ADD COLUMN IF NOT EXISTS opportunities  JSONB`);
    await db.query(`ALTER TABLE forecaster_tasks ADD COLUMN IF NOT EXISTS expert_reports JSONB`);
    await db.query(`ALTER TABLE forecaster_tasks ADD COLUMN IF NOT EXISTS leads_summary  JSONB`);

    // Migration 058: модуль «Проекты» — SEO-проекты + интеграция с Google
    // Search Console (OAuth-токены хранятся строго в зашифрованном виде) +
    // AI-аналитика DeepSeek + публичный read-only шаринг дашборда.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_analysis_status') THEN
          CREATE TYPE project_analysis_status AS ENUM ('queued','running','done','error');
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS projects (
        id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name                   TEXT NOT NULL,
        url                    TEXT NOT NULL,
        audience_description   TEXT,
        gsc_connected          BOOLEAN NOT NULL DEFAULT FALSE,
        gsc_site_url           TEXT,
        gsc_available_sites    JSONB,
        gsc_access_token_enc   TEXT,
        gsc_refresh_token_enc  TEXT,
        gsc_token_expiry       TIMESTAMPTZ,
        share_token            TEXT UNIQUE,
        share_created_at       TIMESTAMPTZ,
        created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_projects_user_created ON projects (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_projects_share_token  ON projects (share_token) WHERE share_token IS NOT NULL`);

    // Migration 062: интеграция с Яндекс.Вебмастером (вторая аналитическая
    // система проекта, симметрично GSC). Токены Yandex OAuth храним строго
    // зашифрованными (AES-256-GCM, projects/tokenCrypto.js) — в колонках *_enc.
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_connected         BOOLEAN NOT NULL DEFAULT FALSE`);
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_site_url          TEXT`);
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_available_sites   JSONB`);
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_access_token_enc  TEXT`);
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_refresh_token_enc TEXT`);
    await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_token_expiry      TIMESTAMPTZ`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS project_analyses (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status          project_analysis_status NOT NULL DEFAULT 'queued',
        range_key       TEXT,
        period_from     DATE,
        period_to       DATE,
        report_markdown TEXT,
        gsc_snapshot    JSONB,
        llm_model       TEXT,
        tokens_in       BIGINT NOT NULL DEFAULT 0,
        tokens_out      BIGINT NOT NULL DEFAULT 0,
        cost_usd        NUMERIC(12, 6) NOT NULL DEFAULT 0,
        error_message   TEXT,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at      TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_analyses_project ON project_analyses (project_id, created_at DESC)`);

    // Migration 061: snapshots GSC как first-class сущность (PR 1 итерации
    // «Проекты»). Хранит «голую» выгрузку GSC отдельно от LLM-отчётов, чтобы
    // (1) собирать срезы без LLM, (2) сравнивать снимки между собой,
    // (3) переиспользовать снимок при rerun отдельных модулей анализа.
    await db.query(`
      CREATE TABLE IF NOT EXISTS project_snapshots (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id      UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
        range_key    TEXT,
        period_from  DATE NOT NULL,
        period_to    DATE NOT NULL,
        source       TEXT NOT NULL DEFAULT 'analysis',
        gsc_data     JSONB NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_snapshots_project ON project_snapshots (project_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_snapshots_period ON project_snapshots (project_id, period_to DESC, period_from)`);
    await db.query(`ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_analyses_snapshot ON project_analyses (snapshot_id) WHERE snapshot_id IS NOT NULL`);

    // Backfill: для исторических analyses со снимком в gsc_snapshot, но без
    // snapshot_id — создаём строку project_snapshots и подвязываем. Безопасно
    // выполнять при каждом старте: курсор пройдёт только по строкам с
    // snapshot_id IS NULL и gsc_snapshot не пуст. На втором запуске — no-op.
    await db.query(`
      DO $$
      DECLARE
        r           RECORD;
        new_snap_id UUID;
        pf          DATE;
        pt          DATE;
      BEGIN
        FOR r IN
          SELECT a.id, a.project_id, a.user_id, a.range_key,
                 a.period_from, a.period_to, a.gsc_snapshot, a.created_at
            FROM project_analyses a
           WHERE a.snapshot_id IS NULL
             AND a.gsc_snapshot IS NOT NULL
             AND a.status = 'done'
        LOOP
          pf := COALESCE(r.period_from,
                         NULLIF(r.gsc_snapshot->'range'->>'startDate','')::date);
          pt := COALESCE(r.period_to,
                         NULLIF(r.gsc_snapshot->'range'->>'endDate','')::date);
          IF pf IS NULL OR pt IS NULL THEN
            CONTINUE;
          END IF;
          INSERT INTO project_snapshots
            (project_id, user_id, range_key, period_from, period_to, source, gsc_data, created_at)
          VALUES
            (r.project_id, r.user_id, r.range_key, pf, pt, 'backfill', r.gsc_snapshot, r.created_at)
          RETURNING id INTO new_snap_id;
          UPDATE project_analyses SET snapshot_id = new_snap_id WHERE id = r.id;
        END LOOP;
      END$$;
    `).catch((e) => {
      // best-effort: если backfill упал, миграция всё равно завершена,
      // снимки появятся естественным образом при новых анализах.
      console.warn('[migrate] project_snapshots backfill skipped:', e.message);
    });

    // ─── Migrations 066–071: расширение модуля «Анализ GSC» (8 слоёв) ──
    // Идемпотентный DDL: ссылочный импорт, кэш парсинга страниц, кэш срезов,
    // история AI-visibility, E-E-A-T и schema-аудитов. См. migrations/066–071.
    await db.query(`
      CREATE TABLE IF NOT EXISTS project_gsc_links (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
        table_type   TEXT NOT NULL,
        donor        TEXT,
        target_page  TEXT,
        anchor       TEXT,
        links        INTEGER NOT NULL DEFAULT 0,
        imported_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_gsc_links_project ON project_gsc_links (project_id, table_type)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS project_page_snapshots (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        parsed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        html_hash    TEXT,
        title        TEXT,
        description  TEXT,
        h1           TEXT,
        jsonld       JSONB,
        microdata    JSONB,
        blocks       JSONB
      );
    `);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_project_page_snapshots_project_url ON project_page_snapshots (project_id, url)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS project_signal_cache (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        signal_key   TEXT NOT NULL,
        hash         TEXT NOT NULL,
        payload      JSONB,
        ttl_sec      INTEGER NOT NULL DEFAULT 3600,
        computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT uq_project_signal_cache UNIQUE (project_id, signal_key)
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_signal_cache_project ON project_signal_cache (project_id, signal_key)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS project_ai_visibility (
        id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        query             TEXT NOT NULL,
        sge_present       BOOLEAN,
        sge_includes_us   BOOLEAN,
        paa               BOOLEAN,
        featured_snippet  BOOLEAN,
        top_domains       JSONB,
        checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_ai_visibility_project ON project_ai_visibility (project_id, checked_at DESC)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS project_eat_audits (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        template     TEXT NOT NULL,
        sample_url   TEXT,
        score        INTEGER,
        dimensions   JSONB,
        gaps         JSONB,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_eat_audits_project ON project_eat_audits (project_id, created_at DESC)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS project_schema_audits (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        template       TEXT NOT NULL,
        sample_url     TEXT,
        present_types  JSONB,
        missing_types  JSONB,
        broken_fields  JSONB,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_project_schema_audits_project ON project_schema_audits (project_id, created_at DESC)`);

    await db.query(`
      CREATE OR REPLACE FUNCTION cleanup_old_task_logs(retain_days INTEGER DEFAULT 30)
      RETURNS INTEGER LANGUAGE plpgsql AS $$
      DECLARE
        deleted INTEGER;
      BEGIN
        DELETE FROM task_logs
         WHERE ts < NOW() - (retain_days || ' days')::interval;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        RETURN deleted;
      END;
      $$;
    `);

    // ─── Migration 038–042: A.E.G.I.S. («Эгида») — мозг системы ────────
    // Идемпотентный DDL для пяти таблиц: aegis_runs, aegis_backlog,
    // aegis_dspy_dataset, aegis_mutations, aegis_brain_versions.
    // Подробности см. migrations/038–042 и AEGIS_SETUP.md.
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_runs (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        kind            VARCHAR(32)  NOT NULL DEFAULT 'super_core_seo',
        task_ref        TEXT,
        niche           TEXT,
        status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
        overall_score   NUMERIC(5,2),
        iterations      INTEGER      NOT NULL DEFAULT 0,
        cost_usd        NUMERIC(10,4) NOT NULL DEFAULT 0,
        tokens_in       BIGINT       NOT NULL DEFAULT 0,
        tokens_out      BIGINT       NOT NULL DEFAULT 0,
        audit           JSONB,
        trace           JSONB,
        error_message   TEXT,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        finished_at     TIMESTAMPTZ
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_runs_created ON aegis_runs (created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_runs_status  ON aegis_runs (status)`);

    // aegis_quality_log — «теневой» датасет (миграция 047). Пишется КАЖДАЯ
    // генерация, независимо от прохождения гейта SPQ ≥ 80. Источник данных
    // для дашборда «Топ причин провалов» и будущего Lessons-репозитория.
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_quality_log (
        id                  BIGSERIAL    PRIMARY KEY,
        article_ref         TEXT         NOT NULL,
        kind                VARCHAR(32)  NOT NULL,
        niche               TEXT,
        spq_overall         NUMERIC(5,2),
        sub                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
        verdict_summary     JSONB        NOT NULL DEFAULT '{}'::jsonb,
        failure_reasons     JSONB        NOT NULL DEFAULT '[]'::jsonb,
        top_failure_layer   TEXT,
        diagnoses           JSONB        NOT NULL DEFAULT '{}'::jsonb,
        status              VARCHAR(24)  NOT NULL DEFAULT 'success',
        passes_gate         BOOLEAN      NOT NULL DEFAULT false,
        model_used          TEXT,
        cost_usd            NUMERIC(10,4),
        iterations          INTEGER      NOT NULL DEFAULT 0,
        user_hash           TEXT,
        created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_quality_log_article_ref ON aegis_quality_log (article_ref)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_created   ON aegis_quality_log (created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_kind      ON aegis_quality_log (kind)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_niche     ON aegis_quality_log (niche)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_top_layer ON aegis_quality_log (top_failure_layer) WHERE top_failure_layer IS NOT NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_spq       ON aegis_quality_log (spq_overall) WHERE spq_overall IS NOT NULL`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_reasons   ON aegis_quality_log USING GIN (failure_reasons)`);
    await db.query(`ALTER TABLE aegis_quality_log ADD COLUMN IF NOT EXISTS prompt_hash TEXT`);
    await db.query(`ALTER TABLE aegis_quality_log ADD COLUMN IF NOT EXISTS prompt_meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_prompt_hash ON aegis_quality_log (prompt_hash) WHERE prompt_hash IS NOT NULL`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_backlog (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        issue_number    INTEGER      NOT NULL UNIQUE,
        title           TEXT         NOT NULL,
        labels          JSONB        NOT NULL DEFAULT '[]'::jsonb,
        niche           TEXT,
        lsi_cluster_id  TEXT,
        status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
        picked_by       TEXT,
        picked_at       TIMESTAMPTZ,
        aegis_run_id    UUID,
        notes           TEXT,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_backlog_status ON aegis_backlog (status)`);
    await db.query(`ALTER TABLE aegis_backlog ADD COLUMN IF NOT EXISTS task_ref TEXT`);
    await db.query(`ALTER TABLE aegis_backlog ADD COLUMN IF NOT EXISTS task_kind TEXT`);
    await db.query(`ALTER TABLE aegis_backlog ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE aegis_backlog ADD COLUMN IF NOT EXISTS spq_overall NUMERIC(5,2)`);
    await db.query(`ALTER TABLE aegis_backlog ADD COLUMN IF NOT EXISTS error TEXT`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_dspy_dataset (
        id              BIGSERIAL    PRIMARY KEY,
        article_ref     TEXT         NOT NULL,
        niche           TEXT,
        user_prompt     TEXT         NOT NULL,
        html_output     TEXT         NOT NULL,
        quality_score   JSONB        NOT NULL,
        spq_overall     NUMERIC(5,2) NOT NULL,
        ppo_weight      NUMERIC(6,3) NOT NULL DEFAULT 1.0,
        ga4_metrics     JSONB,
        model_used      TEXT,
        cost_usd        NUMERIC(10,4),
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        used_in_retrain UUID
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_dspy_niche_spq ON aegis_dspy_dataset (niche, spq_overall DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_dspy_unused    ON aegis_dspy_dataset (used_in_retrain) WHERE used_in_retrain IS NULL`);
    await db.query(`ALTER TABLE aegis_dspy_dataset ADD COLUMN IF NOT EXISTS user_hash TEXT`);
    await db.query(`ALTER TABLE aegis_dspy_dataset ADD COLUMN IF NOT EXISTS source_kind TEXT`);
    await db.query(`ALTER TABLE aegis_dspy_dataset ADD COLUMN IF NOT EXISTS prompt_hash TEXT`);
    await db.query(`ALTER TABLE aegis_dspy_dataset ADD COLUMN IF NOT EXISTS prompt_meta JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await db.query(`
      DELETE FROM aegis_dspy_dataset d
      USING aegis_dspy_dataset d2
      WHERE d.article_ref = d2.article_ref
        AND d.id < d2.id
    `);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_dspy_article_ref ON aegis_dspy_dataset (article_ref)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_dspy_prompt_hash ON aegis_dspy_dataset (prompt_hash) WHERE prompt_hash IS NOT NULL`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_mutations (
        id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        file_path       TEXT         NOT NULL,
        trigger_reason  TEXT,
        abort           BOOLEAN      NOT NULL DEFAULT false,
        abort_reason    TEXT,
        diff_text       TEXT,
        pr_number       INTEGER,
        pr_url          TEXT,
        pr_status       VARCHAR(16),
        tokens_cost_usd NUMERIC(10,4),
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        merged_at       TIMESTAMPTZ
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_mut_created ON aegis_mutations (created_at DESC)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_brain_versions (
        id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        yaml_path         TEXT         NOT NULL,
        sha               VARCHAR(40),
        mean_spq_before   NUMERIC(5,2),
        mean_spq_after    NUMERIC(5,2),
        improvement_pct   NUMERIC(6,3),
        trials_done       INTEGER,
        dataset_size      INTEGER,
        cost_usd          NUMERIC(10,4),
        deployed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        rolled_back_at    TIMESTAMPTZ,
        notes             TEXT
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_brain_deployed ON aegis_brain_versions (deployed_at DESC)`);

    // ─── Migration 043: A.E.G.I.S. Phase 9–13 (Observability / FinOps) ──
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_killswitch (
        id          BIGSERIAL    PRIMARY KEY,
        engaged     BOOLEAN      NOT NULL,
        reason      TEXT,
        set_by      TEXT,
        set_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_kill_set_at ON aegis_killswitch (set_at DESC)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_alerts (
        id          BIGSERIAL    PRIMARY KEY,
        severity    VARCHAR(16)  NOT NULL,
        message     TEXT         NOT NULL,
        payload     JSONB,
        deliveries  JSONB        NOT NULL DEFAULT '[]'::jsonb,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_alerts_created ON aegis_alerts (created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_alerts_severity ON aegis_alerts (severity)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_backups (
        id          BIGSERIAL    PRIMARY KEY,
        status      VARCHAR(16)  NOT NULL,
        targets     JSONB        NOT NULL DEFAULT '[]'::jsonb,
        result      JSONB,
        s3_bucket   TEXT,
        bytes_total BIGINT,
        created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_backups_created ON aegis_backups (created_at DESC)`);

    // ─── Migration 044: A.E.G.I.S. Phase 14 (DSPy cold-start / ε-greedy / vector GC) ──
    await db.query(`
      ALTER TABLE aegis_dspy_dataset
        ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_dspy_seed ON aegis_dspy_dataset (is_seed) WHERE is_seed = TRUE`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_dspy_runs (
        id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        niche              TEXT,
        dry_run            BOOLEAN      NOT NULL DEFAULT FALSE,
        rows_real          INTEGER      NOT NULL DEFAULT 0,
        rows_seed          INTEGER      NOT NULL DEFAULT 0,
        max_trials         INTEGER      NOT NULL DEFAULT 0,
        improvement_pct    NUMERIC(6,3),
        mutation_applied   BOOLEAN      NOT NULL DEFAULT FALSE,
        epsilon_rate       NUMERIC(5,4),
        status             VARCHAR(32)  NOT NULL DEFAULT 'planned',
        cost_usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
        notes              JSONB,
        started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        finished_at        TIMESTAMPTZ
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_dspy_runs_started ON aegis_dspy_runs (started_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_dspy_runs_status  ON aegis_dspy_runs (status)`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_vector_gc_log (
        id              BIGSERIAL    PRIMARY KEY,
        kind            VARCHAR(16)  NOT NULL,
        collection      TEXT,
        run_id          UUID,
        older_than_days INTEGER,
        points_deleted  INTEGER      NOT NULL DEFAULT 0,
        collections_seen INTEGER     NOT NULL DEFAULT 0,
        status          VARCHAR(16)  NOT NULL DEFAULT 'ok',
        reason          TEXT,
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_vector_gc_log_created ON aegis_vector_gc_log (created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_vector_gc_log_run ON aegis_vector_gc_log (run_id) WHERE run_id IS NOT NULL`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_biobrain_versions (
        id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        generation        INTEGER      NOT NULL DEFAULT 0,
        nodes             INTEGER      NOT NULL DEFAULT 0,
        connections       INTEGER      NOT NULL DEFAULT 0,
        mean_fitness      NUMERIC(10,6),
        state_path        TEXT,
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_biobrain_versions_created ON aegis_biobrain_versions (created_at DESC)`);
    // ─── Migration 062: extended fields (B6 — hold-out, rollback, complexity) ──
    await db.query(`ALTER TABLE aegis_biobrain_versions
                       ADD COLUMN IF NOT EXISTS evolve_count       INTEGER,
                       ADD COLUMN IF NOT EXISTS buffer_size        INTEGER,
                       ADD COLUMN IF NOT EXISTS holdout_mae        NUMERIC(10,6),
                       ADD COLUMN IF NOT EXISTS prev_holdout_mae   NUMERIC(10,6),
                       ADD COLUMN IF NOT EXISTS complexity_lambda  NUMERIC(10,6),
                       ADD COLUMN IF NOT EXISTS complexity_penalty NUMERIC(10,6),
                       ADD COLUMN IF NOT EXISTS best_fitness       NUMERIC(10,6),
                       ADD COLUMN IF NOT EXISTS conns              INTEGER,
                       ADD COLUMN IF NOT EXISTS rolled_back        BOOLEAN NOT NULL DEFAULT FALSE,
                       ADD COLUMN IF NOT EXISTS evolved_at         TIMESTAMPTZ`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_biobrain_versions_gen_at
                      ON aegis_biobrain_versions (generation, evolved_at)`);

    // ─── Migration 063: AlgoWatcher — лента обновлений алгоритмов поиска ──
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_algo_updates (
        id            BIGSERIAL    PRIMARY KEY,
        source        TEXT         NOT NULL,
        title         TEXT         NOT NULL,
        url           TEXT         NOT NULL,
        summary       TEXT,
        published_at  TIMESTAMPTZ,
        fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        tags          TEXT[]       NOT NULL DEFAULT '{}',
        severity      NUMERIC(4,3),
        classified_at TIMESTAMPTZ,
        raw           JSONB        NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_algo_updates_src_url ON aegis_algo_updates (source, url)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_algo_updates_published ON aegis_algo_updates (published_at DESC NULLS LAST)`);
    try {
      await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_algo_updates_tags ON aegis_algo_updates USING GIN (tags)`);
    } catch (e) {
      console.warn('[ensureSchema] aegis_algo_updates GIN index skipped:', e.message);
    }

    // ─── Migration 064: SERP outcomes — замыкаем biobrain feedback на позиции ──
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_serp_outcomes (
        id              BIGSERIAL    PRIMARY KEY,
        url             TEXT         NOT NULL,
        queries         TEXT[]       NOT NULL DEFAULT '{}',
        features        REAL[]       NOT NULL DEFAULT '{}',
        feature_labels  TEXT[]       NOT NULL DEFAULT '{}',
        published_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        measured_at     TIMESTAMPTZ,
        avg_position    NUMERIC(7,3),
        best_position   NUMERIC(7,3),
        in_top3         INTEGER      NOT NULL DEFAULT 0,
        in_top10        INTEGER      NOT NULL DEFAULT 0,
        delta_clicks    NUMERIC(12,2),
        delta_ctr       NUMERIC(6,4),
        reward          NUMERIC(6,4),
        status          VARCHAR(20)  NOT NULL DEFAULT 'pending',
        project_id      UUID,
        notes           TEXT
      )
    `);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_serp_outcomes_url_pub ON aegis_serp_outcomes (url, published_at)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_status ON aegis_serp_outcomes (status, published_at)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_published ON aegis_serp_outcomes (published_at DESC)`);

    // ─── Migration 065: Experiments (B4) — активный цикл обучения мозга ──
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_experiments (
        id                      BIGSERIAL    PRIMARY KEY,
        site_key                TEXT         NOT NULL,
        target_url              TEXT         NOT NULL,
        queries                 TEXT[]       NOT NULL DEFAULT '{}',
        uncertainty             NUMERIC(6,4) NOT NULL DEFAULT 0,
        hypothesis              JSONB        NOT NULL DEFAULT '[]'::jsonb,
        baseline_features       REAL[]       NOT NULL DEFAULT '{}',
        baseline_feature_labels TEXT[]       NOT NULL DEFAULT '{}',
        baseline_position       NUMERIC(7,3),
        baseline_clicks         NUMERIC(12,2),
        baseline_impressions    NUMERIC(12,2),
        post_features           REAL[],
        post_position           NUMERIC(7,3),
        post_clicks             NUMERIC(12,2),
        post_impressions        NUMERIC(12,2),
        delta_position          NUMERIC(7,3),
        delta_clicks            NUMERIC(12,2),
        reward                  NUMERIC(6,4),
        status                  VARCHAR(20)  NOT NULL DEFAULT 'planned',
        outcome                 VARCHAR(20),
        planned_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        dispatched_at           TIMESTAMPTZ,
        measured_at             TIMESTAMPTZ,
        backlog_issue_number    INTEGER,
        serp_outcome_id         BIGINT,
        notes                   TEXT
      )
    `);
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_experiments_open
        ON aegis_experiments (site_key, target_url)
        WHERE status IN ('planned', 'dispatched')
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_experiments_status ON aegis_experiments (status, planned_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_experiments_site   ON aegis_experiments (site_key, planned_at DESC)`);

    // ─── Migration 048: prompt tracking + DSPy linkage ────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_prompt_audit (
        id              BIGSERIAL    PRIMARY KEY,
        prompt_key      TEXT         NOT NULL,
        source_path     TEXT         NOT NULL,
        prompt_hash     VARCHAR(64)  NOT NULL,
        previous_hash   VARCHAR(64),
        change_kind     VARCHAR(16)  NOT NULL DEFAULT 'created',
        role            VARCHAR(32)  NOT NULL DEFAULT 'prompt',
        dspy_linked     BOOLEAN      NOT NULL DEFAULT FALSE,
        content_chars   INTEGER      NOT NULL DEFAULT 0,
        vars            JSONB        NOT NULL DEFAULT '[]'::jsonb,
        active          BOOLEAN      NOT NULL DEFAULT TRUE,
        first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_prompt_audit_changed ON aegis_prompt_audit (changed_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_prompt_audit_key ON aegis_prompt_audit (prompt_key, changed_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_prompt_audit_hash ON aegis_prompt_audit (prompt_hash)`);

    // ─── Migration 049: SEO Brain memory + action-plan ────────────────
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_seo_memory (
        site_key        TEXT         PRIMARY KEY,
        site_url        TEXT,
        pages           JSONB        NOT NULL DEFAULT '[]'::jsonb,
        clusters        JSONB        NOT NULL DEFAULT '{}'::jsonb,
        signals         JSONB        NOT NULL DEFAULT '{}'::jsonb,
        reward          JSONB        NOT NULL DEFAULT '{}'::jsonb,
        diagnostics     JSONB        NOT NULL DEFAULT '{}'::jsonb,
        action_plan     JSONB        NOT NULL DEFAULT '{}'::jsonb,
        autonomy_stage  VARCHAR(32)  NOT NULL DEFAULT 'recommend',
        created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_seo_memory_updated ON aegis_seo_memory (updated_at DESC)`);
    // A3: тяжёлые GIN-индексы по полному pages/diagnostics не запрашиваются нигде в
    // коде — только раздували диск/replication lag. Дропаем при старте.
    await db.query(`DROP INDEX IF EXISTS idx_aegis_seo_memory_pages`);
    await db.query(`DROP INDEX IF EXISTS idx_aegis_seo_memory_diagnostics`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_seo_actions (
        id            BIGSERIAL    PRIMARY KEY,
        site_key      TEXT         NOT NULL REFERENCES aegis_seo_memory(site_key) ON DELETE CASCADE,
        action_key    TEXT         NOT NULL,
        action_type   VARCHAR(64)  NOT NULL,
        target_url    TEXT,
        cluster       TEXT,
        intent        TEXT,
        priority      INTEGER      NOT NULL DEFAULT 0,
        status        VARCHAR(32)  NOT NULL DEFAULT 'recommended',
        payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
        created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (site_key, action_key)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_seo_actions_site_priority ON aegis_seo_actions (site_key, priority DESC, updated_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_seo_actions_status ON aegis_seo_actions (status)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_seo_actions_type ON aegis_seo_actions (action_type)`);

    // C1: observations — фактические GA4/GSC дельты + reward на URL/неделя.
    await db.query(`
      CREATE TABLE IF NOT EXISTS aegis_seo_observations (
        id                BIGSERIAL    PRIMARY KEY,
        site_key          TEXT         NOT NULL,
        url               TEXT         NOT NULL,
        observed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        week_start        DATE         NOT NULL,
        clicks            INTEGER,
        impressions       INTEGER,
        ctr               DOUBLE PRECISION,
        position          DOUBLE PRECISION,
        sessions          INTEGER,
        engagement_rate   DOUBLE PRECISION,
        reward_overall    DOUBLE PRECISION,
        reward_components JSONB        NOT NULL DEFAULT '{}'::jsonb,
        delta             JSONB        NOT NULL DEFAULT '{}'::jsonb,
        source            VARCHAR(32)  NOT NULL DEFAULT 'manual',
        created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        UNIQUE (site_key, url, week_start)
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_seo_observations_site_week ON aegis_seo_observations (site_key, week_start DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_aegis_seo_observations_url ON aegis_seo_observations (url, observed_at DESC)`);

    // Migration 059: category_lead_tasks — инструмент «Lead-text + Фасетный
    // SEO-оптимизатор». Хранит входные данные, lead-text (Проход 1), таблицу
    // фасет-оптимизатора (Проход 2), мост к мета-тегам и метрики стоимости.
    await db.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'category_lead_status') THEN
          CREATE TYPE category_lead_status AS ENUM ('queued', 'running', 'done', 'error');
        END IF;
      END$$;
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS category_lead_tasks (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name          TEXT NOT NULL DEFAULT '',
        category      TEXT NOT NULL DEFAULT '',
        status        category_lead_status NOT NULL DEFAULT 'queued',
        error_message TEXT,
        inputs        JSONB,
        lead_text     JSONB,
        facet_table   JSONB,
        meta          JSONB,
        diagnostics   JSONB,
        llm_model     TEXT,
        tokens_in     BIGINT NOT NULL DEFAULT 0,
        tokens_out    BIGINT NOT NULL DEFAULT 0,
        cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at    TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_category_lead_user_created ON category_lead_tasks (user_id, created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_category_lead_status ON category_lead_tasks (status)`);
    // Migration 060: SEO/GEO 2026 — JSON-LD blocks для категорий.
    await db.query(`ALTER TABLE category_lead_tasks ADD COLUMN IF NOT EXISTS json_ld_blocks JSONB`);

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
