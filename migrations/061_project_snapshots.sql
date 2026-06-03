-- Migration 061:
--   Snapshots GSC как first-class сущность (PR 1 «следующей итерации»
--   модуля Проекты). До этого выгрузка GSC жила только внутри
--   project_analyses.gsc_snapshot — один JSONB на запуск анализа,
--   без возможности отдельно собирать/сравнивать срезы.
--
--   Новая таблица project_snapshots хранит «голую» выгрузку GSC за
--   диапазон дат; project_analyses.snapshot_id ссылается на снимок,
--   на котором анализ был построен (NULL для исторических строк до
--   миграции — backfill идёт в backend/server.js ensureSchema()).
--
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  range_key    TEXT,            -- '7d' | '28d' | '3m' | '6m' | 'custom'
  period_from  DATE NOT NULL,
  period_to    DATE NOT NULL,
  source       TEXT NOT NULL DEFAULT 'analysis',     -- 'analysis' | 'manual' | 'backfill'
  gsc_data     JSONB NOT NULL,  -- totals/series/top_queries/top_pages/...
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_snapshots_project
  ON project_snapshots (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_snapshots_period
  ON project_snapshots (project_id, period_to DESC, period_from);

ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS snapshot_id UUID
    REFERENCES project_snapshots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_project_analyses_snapshot
  ON project_analyses (snapshot_id) WHERE snapshot_id IS NOT NULL;
