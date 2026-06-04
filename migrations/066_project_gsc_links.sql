-- Migration 066:
--   Импорт раздела «Ссылки» из Google Search Console (п.1, п.2 ТЗ).
--   Search Analytics API НЕ отдаёт отчёт «Ссылки», поэтому данные
--   импортируются вручную из GSC UI (CSV: Top linking sites / Top linked
--   pages / Top linking text). Один актуальный срез на тип таблицы.
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_gsc_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  table_type   TEXT NOT NULL,            -- 'sites' | 'pages' | 'anchors'
  donor        TEXT,                     -- для table_type='sites'
  target_page  TEXT,                     -- для table_type='pages'
  anchor       TEXT,                     -- для table_type='anchors'
  links        INTEGER NOT NULL DEFAULT 0,
  imported_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_project_gsc_links_project
  ON project_gsc_links (project_id, table_type);
