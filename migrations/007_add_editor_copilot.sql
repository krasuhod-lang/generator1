-- =================================================================
-- Migration 007: AI-Copilot редактор готовой статьи
-- =================================================================
-- Добавляет:
--   * tasks.full_html_edited — текущая версия HTML статьи после ручных
--     правок, сделанных через AI-Copilot. NULL = используется оригинал
--     full_html. Сохраняется между перезагрузками страницы / сессиями.
--   * Таблицу editor_copilot_sessions — одна запись на (task,user),
--     хранит агрегаты токенов/стоимости по всем операциям копилота.
--   * Таблицу editor_copilot_operations — отдельная операция/генерация
--     (промпт + результат + логи + статус), используется фронтом для
--     восстановления состояния после F5 и для журнала логов.
-- Все операции идемпотентны (IF NOT EXISTS / DO blocks).
-- =================================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS full_html_edited TEXT;

-- ── ENUM: editor_copilot_action ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'editor_copilot_action') THEN
    CREATE TYPE editor_copilot_action AS ENUM (
      'factcheck',
      'add_faq',
      'enrich_lsi',
      'expand_section',
      'anti_spam',
      'custom'
    );
  END IF;
END$$;

-- ── ENUM: editor_copilot_status ──────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'editor_copilot_status') THEN
    CREATE TYPE editor_copilot_status AS ENUM (
      'pending',
      'streaming',
      'done',
      'error',
      'cancelled'
    );
  END IF;
END$$;

-- ── ENUM: editor_copilot_apply_mode ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'editor_copilot_apply_mode') THEN
    CREATE TYPE editor_copilot_apply_mode AS ENUM (
      'replace',
      'insert_below'
    );
  END IF;
END$$;

-- ── TABLE: editor_copilot_sessions ───────────────────────────────
CREATE TABLE IF NOT EXISTS editor_copilot_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id           UUID UNIQUE NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  total_tokens_in   BIGINT      NOT NULL DEFAULT 0,
  total_tokens_out  BIGINT      NOT NULL DEFAULT 0,
  total_cost_usd    NUMERIC(12,6) NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_copilot_sessions_user_id ON editor_copilot_sessions(user_id);

-- ── TABLE: editor_copilot_operations ─────────────────────────────
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

  -- Журнал событий: массив объектов { ts, level, message }.
  -- JSONB (не JSONB[]) — удобнее работать массивом из приложения.
  logs            JSONB                      NOT NULL DEFAULT '[]'::jsonb,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_copilot_ops_task_created
  ON editor_copilot_operations (task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_copilot_ops_session
  ON editor_copilot_operations (session_id);
CREATE INDEX IF NOT EXISTS idx_copilot_ops_status
  ON editor_copilot_operations (status);

-- Триггер для updated_at сессии (функция уже есть из 001_initial_schema)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_copilot_sessions_updated_at'
  ) THEN
    CREATE TRIGGER trg_copilot_sessions_updated_at
      BEFORE UPDATE ON editor_copilot_sessions
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  END IF;
END$$;
