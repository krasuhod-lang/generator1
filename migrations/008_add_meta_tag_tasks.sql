-- =================================================================
-- Migration 008: Bulk Meta-Tag Generator (DrMax v25)
-- =================================================================
-- Хранит задачи и результаты генератора Title/Description
-- по списку ключевых запросов через XMLStock + Gemini.
-- H1 НЕ генерируется (требование заказчика).
-- =================================================================

-- ── ENUM: meta_tag_task_status ────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'meta_tag_task_status') THEN
    CREATE TYPE meta_tag_task_status AS ENUM (
      'pending', 'in_progress', 'done', 'error', 'cancelled'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS meta_tag_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,

  -- Глобальные параметры (общие для всех ключей задачи)
  niche           TEXT,
  lr              TEXT,           -- Yandex region code (например, 213 = Москва)
  toponym         TEXT,
  brand           TEXT,
  phone           TEXT,
  summary         TEXT,
  keywords        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- массив строк

  -- Состояние выполнения
  status          meta_tag_task_status NOT NULL DEFAULT 'pending',
  progress_current INTEGER NOT NULL DEFAULT 0,
  progress_total   INTEGER NOT NULL DEFAULT 0,
  active_keyword   TEXT,
  error_message    TEXT,

  -- Результаты — массив {keyword, status, error?, serp[], semantics{}, metas{}}
  results         JSONB NOT NULL DEFAULT '[]'::jsonb,
  logs            JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Аудит
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_user_created
  ON meta_tag_tasks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_status
  ON meta_tag_tasks (status);
