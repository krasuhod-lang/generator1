-- ============================================================================
-- 113: GIST + LinguaForensic DSPy Pipeline (§14 ТЗ)
--
-- Таблица article_tasks — задачи генерации SEO-контента по логике GIST:
-- съём релевантности (M0), парсинг ТОПа (M1), шум конкурентов (M2),
-- information_delta (M3), структура/персона/генерация (M4–M6),
-- redundancy + GIST Score (M7), LinguaForensic v3.6 (M8), рерайт (M9),
-- SEO-форматирование (M10).
-- ============================================================================

CREATE TABLE IF NOT EXISTS article_tasks (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Вход
  query                  TEXT NOT NULL,
  target_audience        TEXT,
  domain                 TEXT,
  status                 TEXT NOT NULL DEFAULT 'pending', -- pending|running|done|error
  error_message          TEXT,

  -- §14: поля пайплайна
  top10_claims_json      JSONB,
  information_delta_json JSONB,
  gist_score             NUMERIC(5,2),
  persona_json           JSONB,
  aio_trigger_group      TEXT,
  aio_trigger_rate       NUMERIC(4,3),
  content_format         TEXT,
  zero_click_risk        TEXT,
  robotness_score        NUMERIC(5,2),
  robotness_ci           TEXT,
  llm_family             TEXT,
  knockoff_s             NUMERIC(8,4),
  top_ai_categories      JSONB,
  full_detection_report  JSONB,
  rewrite_iterations     INTEGER NOT NULL DEFAULT 0,
  pipeline_stage         TEXT NOT NULL DEFAULT 'M0',
  redundancy_report_json JSONB,
  fluency_metrics_json   JSONB,
  lsi_coverage_pct       NUMERIC(5,2),
  aio_snippets_count     INTEGER,
  schema_type            TEXT,

  -- Результат
  outline_json           JSONB,
  final_content          TEXT,
  meta_json              JSONB,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_article_tasks_user_created
  ON article_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_article_tasks_status
  ON article_tasks (status);
CREATE INDEX IF NOT EXISTS idx_article_tasks_stage
  ON article_tasks (pipeline_stage);
