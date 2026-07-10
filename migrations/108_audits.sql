-- 108_audits.sql — модуль «Аудиты» (технический и SEO-аудит сайта).
-- Раздел «Парсер сайта» переименован в «Аудиты»; краулинг выполняет
-- Python-микросервис audit/ (asyncio + aiohttp + BS4 + networkx), Node —
-- только роутер + персист финального отчёта в PostgreSQL.
--
-- ВАЖНО: миграция дублируется в server.js ensureSchema (как и все остальные),
-- чтобы dev/staging накатывали схему без отдельного шага.

CREATE TABLE IF NOT EXISTS audit_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url          VARCHAR(2048) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
    -- pending | running | done | failed | cancelled
  config       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- max_pages, max_depth, options
  progress     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { crawled, total_found }
  summary      JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { total_pages, issues_*, health_score }
  report       JSONB NULL,                          -- полный финальный отчёт
  error        TEXT NULL,
  started_at   TIMESTAMPTZ NULL,
  finished_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_tasks_user_created
  ON audit_tasks(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_pages (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id            UUID NOT NULL REFERENCES audit_tasks(id) ON DELETE CASCADE,
  url                TEXT NOT NULL,
  status_code        INTEGER,
  crawl_depth        INTEGER,
  response_time_ms   INTEGER,
  content_size_bytes INTEGER,
  title              TEXT,
  title_length       INTEGER,
  meta_description   TEXT,
  h1_count           INTEGER,
  word_count         INTEGER,
  text_html_ratio    DECIMAL(5,4),
  content_hash       VARCHAR(32),
  is_https           BOOLEAN,
  indexable          BOOLEAN,
  canonical          TEXT,
  issues             JSONB NOT NULL DEFAULT '[]'::jsonb  -- массив кодов ошибок
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_pages_task_url
  ON audit_pages(task_id, url);

CREATE INDEX IF NOT EXISTS idx_audit_pages_task
  ON audit_pages(task_id);

CREATE TABLE IF NOT EXISTS audit_issues (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id    UUID NOT NULL REFERENCES audit_tasks(id) ON DELETE CASCADE,
  page_url   TEXT,
  issue_code VARCHAR(50) NOT NULL,
  severity   TEXT NOT NULL,  -- critical | high | medium | low
  context    JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_audit_issues_task
  ON audit_issues(task_id);

CREATE INDEX IF NOT EXISTS idx_audit_issues_task_severity
  ON audit_issues(task_id, severity);
