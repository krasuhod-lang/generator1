-- Migration 071:
--   История аудита микроразметки по шаблонам страниц проекта (п.8 ТЗ). Хранит
--   найденные/недостающие/битые типы Schema.org по каждому шаблону.
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_schema_audits (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id     UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  template       TEXT NOT NULL,
  sample_url     TEXT,
  present_types  JSONB,
  missing_types  JSONB,
  broken_fields  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_schema_audits_project
  ON project_schema_audits (project_id, created_at DESC);
