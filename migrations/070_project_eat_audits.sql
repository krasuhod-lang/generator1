-- Migration 070:
--   История E-E-A-T оценок по шаблонам страниц проекта (п.5 ТЗ). Каждая строка —
--   один шаблон (каталог/услуги/товар/блог/о компании) с score 0..100 и списком
--   пробелов по Experience/Expertise/Authoritativeness/Trust.
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_eat_audits (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template     TEXT NOT NULL,
  sample_url   TEXT,
  score        INTEGER,
  dimensions   JSONB,
  gaps         JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_eat_audits_project
  ON project_eat_audits (project_id, created_at DESC);
