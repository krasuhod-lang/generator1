-- Migration 067:
--   Кэш результатов парсинга страниц проекта (п.4, п.5 ТЗ): title/description/
--   H1 + извлечённые JSON-LD / microdata / блоки. Переиспользуется meta-аудитом,
--   E-E-A-T и schema-аудитом, чтобы не парсить один URL многократно (TTL 24ч).
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_page_snapshots (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  parsed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  html_hash    TEXT,
  title        TEXT,
  description  TEXT,
  h1           TEXT,
  jsonld       JSONB,
  microdata    JSONB,
  blocks       JSONB
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_project_page_snapshots_project_url
  ON project_page_snapshots (project_id, url);
