-- Migration 075: Smart Report Builder V2.
--
-- Модуль публичных отчётов поверх существующих SEO-проектов.
-- Стиль миграций — VARCHAR + CHECK (см. 032_forecaster_tasks.sql), без новых
-- ENUM-типов. Все таблицы дублируются в backend/server.js ensureSchema().

-- 1. Расширение таблицы projects (служит «брендом» отчёта).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_url        TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS color_accent    VARCHAR(7);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS keys_so_domain  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS keys_so_region  VARCHAR(8);

-- 2. Черновики отчётов.
CREATE TABLE IF NOT EXISTS report_drafts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  date_from         DATE NOT NULL,
  date_to           DATE NOT NULL,
  status            VARCHAR(16) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','published','archived')),
  config            JSONB NOT NULL DEFAULT '{}'::jsonb,
  tasks_blocks      JSONB NOT NULL DEFAULT '[]'::jsonb,
  llm_summary       TEXT,
  llm_highlights    JSONB,
  llm_growth        TEXT,
  llm_status        VARCHAR(16) NOT NULL DEFAULT 'idle'
                    CHECK (llm_status IN ('idle','queued','running','done','error')),
  llm_job_id        UUID,
  llm_error         TEXT,
  llm_generated_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_report_drafts_user_created
  ON report_drafts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_report_drafts_project
  ON report_drafts (project_id, created_at DESC);

-- 3. Опубликованные ссылки.
CREATE TABLE IF NOT EXISTS shared_reports (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id        UUID NOT NULL REFERENCES report_drafts(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  uuid            VARCHAR(64) NOT NULL UNIQUE,
  mode            VARCHAR(16) NOT NULL DEFAULT 'live'
                  CHECK (mode IN ('snapshot','live')),
  snapshot_data   JSONB,
  expires_at      TIMESTAMPTZ,
  password_hash   TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  view_count      INTEGER NOT NULL DEFAULT 0,
  last_viewed_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_reports_user      ON shared_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shared_reports_draft     ON shared_reports (draft_id);
CREATE INDEX IF NOT EXISTS idx_shared_reports_active    ON shared_reports (is_active) WHERE is_active = TRUE;

-- 4. Кэш Keys.so (помесячно по домену).
CREATE TABLE IF NOT EXISTS keys_so_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain          TEXT NOT NULL,
  date            DATE NOT NULL,
  yandex_traffic  INTEGER,
  google_traffic  INTEGER,
  visibility      NUMERIC(10,4),
  keywords_top1   INTEGER,
  keywords_top3   INTEGER,
  keywords_top10  INTEGER,
  keywords_total  INTEGER,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(domain, date)
);

CREATE INDEX IF NOT EXISTS idx_keys_so_cache_domain_date
  ON keys_so_cache (domain, date DESC);

-- 5. Лог автоматически выполненных и ручных работ.
CREATE TABLE IF NOT EXISTS tasks_auto_log (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  task_type       VARCHAR(32) NOT NULL
                  CHECK (task_type IN ('content_generation','meta_update','link_article','technical_seo','other')),
  title           TEXT NOT NULL,
  description     TEXT,
  performed_at    DATE NOT NULL DEFAULT CURRENT_DATE,
  source          VARCHAR(16) NOT NULL DEFAULT 'platform_auto'
                  CHECK (source IN ('platform_auto','manual')),
  is_hidden       BOOLEAN NOT NULL DEFAULT FALSE,
  ref_table       TEXT,
  ref_id          UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_auto_log_project_perf
  ON tasks_auto_log (project_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_auto_log_type
  ON tasks_auto_log (project_id, task_type, performed_at DESC);
