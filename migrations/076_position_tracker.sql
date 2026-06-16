-- Migration 076: Position Tracker
--
-- Модуль «Съём позиций» через XMLStock: пользователь создаёт проект
-- (домен + регион + движок), заводит список ключевых запросов и запускает
-- регулярные снятия. По истории позиций строятся графики (день/неделя/месяц)
-- и выводятся «выросло/упало».
--
-- Таблицы:
--   • position_projects  — сущность проекта отслеживания.
--   • position_keywords  — список запросов проекта.
--   • position_runs      — отдельный «съём» (запуск пайплайна).
--   • position_results   — позиция запроса в рамках конкретного съёма.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'position_engine') THEN
    CREATE TYPE position_engine AS ENUM ('yandex', 'google', 'both');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'position_device') THEN
    CREATE TYPE position_device AS ENUM ('desktop', 'mobile');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'position_schedule') THEN
    CREATE TYPE position_schedule AS ENUM ('daily', 'weekly', 'manual');
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'position_run_status') THEN
    CREATE TYPE position_run_status AS ENUM ('queued', 'processing', 'done', 'error');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS position_projects (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL DEFAULT '',
  domain      TEXT NOT NULL,
  engine      position_engine   NOT NULL DEFAULT 'yandex',
  geo_lr      TEXT NOT NULL DEFAULT '',  -- Yandex region code (lr)
  geo_loc     TEXT NOT NULL DEFAULT '',  -- Google location string
  device      position_device   NOT NULL DEFAULT 'desktop',
  schedule    position_schedule NOT NULL DEFAULT 'manual',
  last_run_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_position_projects_user
  ON position_projects (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_projects_schedule
  ON position_projects (schedule, last_run_at);

CREATE TABLE IF NOT EXISTS position_keywords (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES position_projects(id) ON DELETE CASCADE,
  query      TEXT NOT NULL,
  target_url TEXT,
  tags       JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, query)
);

CREATE INDEX IF NOT EXISTS idx_position_keywords_project
  ON position_keywords (project_id, is_active);

CREATE TABLE IF NOT EXISTS position_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES position_projects(id) ON DELETE CASCADE,
  engine          TEXT NOT NULL,  -- 'yandex' | 'google' (one row per engine)
  status          position_run_status NOT NULL DEFAULT 'queued',
  error           TEXT,
  keywords_total  INTEGER NOT NULL DEFAULT 0,
  keywords_done   INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_position_runs_project
  ON position_runs (project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_runs_status
  ON position_runs (status);

CREATE TABLE IF NOT EXISTS position_results (
  id           BIGSERIAL PRIMARY KEY,
  run_id       UUID NOT NULL REFERENCES position_runs(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL REFERENCES position_projects(id) ON DELETE CASCADE,
  keyword_id   UUID NOT NULL REFERENCES position_keywords(id) ON DELETE CASCADE,
  engine       TEXT NOT NULL,
  position     INTEGER,                 -- NULL = не найдено в ТОП-100
  found_url    TEXT,
  serp_snippet TEXT,
  checked_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(run_id, keyword_id, engine)
);

CREATE INDEX IF NOT EXISTS idx_position_results_keyword_date
  ON position_results (keyword_id, engine, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_position_results_project_date
  ON position_results (project_id, engine, checked_at DESC);
