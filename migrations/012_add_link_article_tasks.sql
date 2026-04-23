-- =================================================================
-- Migration 012: Link Article Generator
-- =================================================================
-- Хранит задачи и результаты генератора ссылочной статьи.
-- Использует Pre-Stage0/Stage0/Stage1/Stage2 логику (DeepSeek)
-- + Gemini 3.1 Pro Preview для финальной генерации статьи
-- + Nano Banana Pro (gemini-3-pro-image-preview) для изображений.
-- =================================================================

-- ── ENUM: link_article_status ─────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'link_article_status') THEN
    CREATE TYPE link_article_status AS ENUM (
      'queued', 'running', 'done', 'error'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS link_article_tasks (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Inputs
  topic              TEXT NOT NULL,
  anchor_text        TEXT NOT NULL,
  anchor_url         TEXT NOT NULL,
  focus_notes        TEXT,
  output_format      VARCHAR(16) NOT NULL DEFAULT 'html',  -- 'html' | 'formatted_text'

  -- Status / progress
  status             link_article_status NOT NULL DEFAULT 'queued',
  progress_pct       INTEGER NOT NULL DEFAULT 0,
  current_stage      TEXT,
  error_message      TEXT,

  -- Per-stage analytical outputs (JSONB for forward-compat)
  strategy_context   JSONB,
  stage0_audience    JSONB,
  stage1_intents     JSONB,
  stage2_structure   JSONB,

  -- Final article
  article_html       TEXT,
  article_plain      TEXT,

  -- Image prompts + rendered images
  -- [{ slot, section_h2, visual_prompt, negative_prompt, alt_ru,
  --    image_base64, mime_type, status, error }]
  image_prompts      JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Metrics
  deepseek_tokens_in   BIGINT NOT NULL DEFAULT 0,
  deepseek_tokens_out  BIGINT NOT NULL DEFAULT 0,
  gemini_tokens_in     BIGINT NOT NULL DEFAULT 0,
  gemini_tokens_out    BIGINT NOT NULL DEFAULT 0,
  gemini_image_calls   INTEGER NOT NULL DEFAULT 0,
  cost_usd             NUMERIC(12, 6) NOT NULL DEFAULT 0,

  -- Task log (short text events for UI)
  logs               JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Audit
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at         TIMESTAMPTZ,
  completed_at       TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_article_user_created
  ON link_article_tasks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_article_status
  ON link_article_tasks (status);

-- ── Events (audit stream) ─────────────────────────────────────────
-- Отдельный журнал событий пайплайна. Inline-массив logs JSONB в
-- link_article_tasks остаётся «горячей» витриной для UI; сюда льётся
-- длинный аудит-лог (для админ-панели и ретроспективного разбора).
CREATE TABLE IF NOT EXISTS link_article_events (
  id         BIGSERIAL PRIMARY KEY,
  task_id    UUID NOT NULL REFERENCES link_article_tasks(id) ON DELETE CASCADE,
  stage      TEXT,
  level      VARCHAR(8) NOT NULL DEFAULT 'info',  -- info | ok | warn | err
  message    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_link_article_events_task_time
  ON link_article_events (task_id, created_at);
