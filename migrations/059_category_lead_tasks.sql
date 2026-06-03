-- Migration 059: category_lead_tasks
-- Инструмент «Lead-text + Фасетный SEO-оптимизатор» (categoryLead).
-- Хранит входные параметры (категория, фильтры, интенты, опц. GSC-проект),
-- результат Прохода 1 (lead_text), Прохода 2 (facet_table), мост к мета-тегам
-- (meta), диагностику сбора данных и метрики стоимости LLM.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'category_lead_status') THEN
    CREATE TYPE category_lead_status AS ENUM ('queued', 'running', 'done', 'error');
  END IF;
END$$;

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
);

CREATE INDEX IF NOT EXISTS idx_category_lead_user_created
  ON category_lead_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_category_lead_status
  ON category_lead_tasks (status);
