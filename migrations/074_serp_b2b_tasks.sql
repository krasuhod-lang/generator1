-- Migration 074: serp_b2b_tasks
-- SERP Crawler & B2B Contact Extractor Pipeline.
-- Хранит входные параметры (поисковый запрос, кол-во страниц, движок),
-- агрегированный прогресс, JSONB-массив с результатами по сайтам и
-- сводный diagnostics-блок по этапам пайплайна.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'serp_b2b_status') THEN
    CREATE TYPE serp_b2b_status AS ENUM ('queued', 'running', 'done', 'error');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS serp_b2b_tasks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT '',
  query           TEXT NOT NULL DEFAULT '',
  search_engine   TEXT NOT NULL DEFAULT 'yandex',
  depth_pages     INTEGER NOT NULL DEFAULT 1,
  status          serp_b2b_status NOT NULL DEFAULT 'queued',
  error_message   TEXT,
  inputs          JSONB,
  results         JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_sites     INTEGER NOT NULL DEFAULT 0,
  processed_sites INTEGER NOT NULL DEFAULT 0,
  diagnostics     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_serp_b2b_user_created
  ON serp_b2b_tasks (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_serp_b2b_status
  ON serp_b2b_tasks (status);
