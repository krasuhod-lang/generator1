-- =================================================================
-- Migration 015: Article Topic Forecaster (Темы статей)
-- =================================================================
-- Хранит задачи и результаты «foresight»-генератора тем статей.
-- Один Gemini-вызов (gemini-3.1-pro-preview) с большим текстовым
-- foresight-промптом на выходе → markdown-отчёт со слабыми сигналами,
-- emerging-трендами, контентными кластерами и Strategic Action Plan.
--
-- Поддерживаются два режима:
--   • mode='main'      — первичный анализ ниши (Промт 1).
--   • mode='deep_dive' — углублённая проработка отдельного тренда
--                        (Промт 2). parent_task_id обязателен и
--                        ссылается на main-задачу. trend_name —
--                        название тренда из вывода main-задачи.
-- =================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'article_topic_status') THEN
    CREATE TYPE article_topic_status AS ENUM (
      'queued', 'running', 'done', 'error'
    );
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'article_topic_mode') THEN
    CREATE TYPE article_topic_mode AS ENUM (
      'main', 'deep_dive'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS article_topic_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Mode + ссылка на родительскую main-задачу для deep-dive
  mode                article_topic_mode NOT NULL DEFAULT 'main',
  parent_task_id      UUID REFERENCES article_topic_tasks(id) ON DELETE SET NULL,

  -- Inputs (main mode)
  niche               TEXT NOT NULL,
  region              TEXT NOT NULL DEFAULT '',
  horizon             TEXT NOT NULL DEFAULT '',
  audience            TEXT NOT NULL DEFAULT '',          -- B2B | B2C | смешанная
  market_stage        TEXT NOT NULL DEFAULT '',          -- зарождающийся | растущий | зрелый | стагнирующий
  search_ecosystem    TEXT NOT NULL DEFAULT '',          -- Google | Яндекс | оба
  top_competitors     TEXT NOT NULL DEFAULT '',

  -- Inputs (deep_dive mode)
  trend_name          TEXT,

  -- Status / progress
  status              article_topic_status NOT NULL DEFAULT 'queued',
  error_message       TEXT,

  -- Output: markdown-отчёт от Gemini (длинный, до сотен KB)
  result_markdown     TEXT,

  -- Метрики
  llm_model           TEXT,
  gemini_tokens_in    BIGINT NOT NULL DEFAULT 0,
  gemini_tokens_out   BIGINT NOT NULL DEFAULT 0,
  cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,

  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_article_topic_user_created
  ON article_topic_tasks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_article_topic_status
  ON article_topic_tasks (status);

CREATE INDEX IF NOT EXISTS idx_article_topic_parent
  ON article_topic_tasks (parent_task_id)
  WHERE parent_task_id IS NOT NULL;
