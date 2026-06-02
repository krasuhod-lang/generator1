-- Migration 058:
--   Модуль «Проекты» — управление SEO-проектами с интеграцией Google Search
--   Console (OAuth 2.0), дашбордом показателей и AI-аналитикой DeepSeek.
--
--   Требование безопасности: токены Google OAuth (access/refresh) хранятся
--   строго в зашифрованном виде (AES-256-GCM, см.
--   backend/src/services/projects/tokenCrypto.js) — в колонках *_enc.
--
--   Дублируется в backend/server.js ensureSchema() для авто-применения при
--   старте Node-процесса. Этот файл — для ручного применения вне Node.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'project_analysis_status') THEN
    CREATE TYPE project_analysis_status AS ENUM ('queued','running','done','error');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS projects (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  url                    TEXT NOT NULL,
  audience_description   TEXT,
  gsc_connected          BOOLEAN NOT NULL DEFAULT FALSE,
  gsc_site_url           TEXT,
  gsc_available_sites    JSONB,
  gsc_access_token_enc   TEXT,   -- зашифрованный access-токен Google
  gsc_refresh_token_enc  TEXT,   -- зашифрованный refresh-токен Google
  gsc_token_expiry       TIMESTAMPTZ,
  share_token            TEXT UNIQUE,
  share_created_at       TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_created ON projects (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_projects_share_token  ON projects (share_token) WHERE share_token IS NOT NULL;

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

CREATE INDEX IF NOT EXISTS idx_project_analyses_project ON project_analyses (project_id, created_at DESC);
