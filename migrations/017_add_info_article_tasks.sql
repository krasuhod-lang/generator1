-- Migration 017: Info Article Generator (Статья в блог)
--
-- Изолированная таблица info_article_tasks + журнал info_article_events
-- + ENUM info_article_status для информационной статьи в блог.
-- Дублирует то, что server.js (ensureSchema()) выполняет идемпотентно
-- при каждом старте — этот файл нужен для ручного применения вне Node.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'info_article_status') THEN
    CREATE TYPE info_article_status AS ENUM ('queued', 'running', 'done', 'error');
  END IF;
END$$;

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
);

CREATE INDEX IF NOT EXISTS idx_info_article_user_created ON info_article_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_info_article_status       ON info_article_tasks (status);
CREATE INDEX IF NOT EXISTS idx_info_article_eeat_score
  ON info_article_tasks (eeat_score) WHERE eeat_score IS NOT NULL;

CREATE TABLE IF NOT EXISTS info_article_events (
  id         BIGSERIAL PRIMARY KEY,
  task_id    UUID NOT NULL REFERENCES info_article_tasks(id) ON DELETE CASCADE,
  stage      TEXT,
  level      VARCHAR(8) NOT NULL DEFAULT 'info',
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_info_article_events_task_time
  ON info_article_events (task_id, created_at);
