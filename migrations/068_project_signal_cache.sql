-- Migration 068:
--   Универсальный кэш детерминированных срезов проекта (п.6 ТЗ): commercial,
--   breakdowns, page_decay, link_audit, eat, schema и т.п. кэшируются по
--   hash(range, project_id, sources). Re-run использует кэш при совпадении hash,
--   что снижает повторные GSC-запросы и LLM-токены. UNIQUE(project_id,signal_key)
--   нужен для ON CONFLICT upsert в signalCache.writeSignal.
--   Дублируется в backend/server.js ensureSchema() для авто-применения.

CREATE TABLE IF NOT EXISTS project_signal_cache (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  signal_key   TEXT NOT NULL,
  hash         TEXT NOT NULL,
  payload      JSONB,
  ttl_sec      INTEGER NOT NULL DEFAULT 3600,
  computed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_project_signal_cache UNIQUE (project_id, signal_key)
);

CREATE INDEX IF NOT EXISTS idx_project_signal_cache_project
  ON project_signal_cache (project_id, signal_key);
