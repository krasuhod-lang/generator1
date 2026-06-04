-- Migration 069:
--   История проверки присутствия в нейровыдаче / SERP-фичах (п.7 ТЗ, GEO/AEO).
--   Search API не отдаёт факт показа в AI Overviews/SGE — фиксируем косвенные
--   сигналы (наш домен в топе, PAA, featured snippet) по приоритетным запросам.
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_ai_visibility (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  query             TEXT NOT NULL,
  sge_present       BOOLEAN,
  sge_includes_us   BOOLEAN,
  paa               BOOLEAN,
  featured_snippet  BOOLEAN,
  top_domains       JSONB,
  checked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_ai_visibility_project
  ON project_ai_visibility (project_id, checked_at DESC);
