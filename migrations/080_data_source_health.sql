-- 080_data_source_health.sql — таблица для мониторинга свежести данных по
-- внешним источникам (GSC, Yandex.Webmaster, Keys.so, Backlinks).
-- ТЗ §5.2: для каждого источника хранить last_successful_sync_at,
-- source_max_date, expected_max_date, rows_last_sync, is_partial_period, status.
--
-- Идемпотентная миграция: CREATE TABLE IF NOT EXISTS + ALTER ADD COLUMN
-- IF NOT EXISTS — безопасно при повторном применении на runtime через
-- backend/server.js ensureSchema().

CREATE TABLE IF NOT EXISTS data_source_health (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id                UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source                    VARCHAR(32) NOT NULL,
  last_successful_sync_at   TIMESTAMPTZ,
  source_max_date           DATE,
  expected_max_date         DATE,
  rows_last_sync            INTEGER NOT NULL DEFAULT 0,
  is_partial_period         BOOLEAN NOT NULL DEFAULT FALSE,
  status                    VARCHAR(16) NOT NULL DEFAULT 'ok',
  last_error                TEXT,
  meta                      JSONB,
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_data_source_health UNIQUE (project_id, source)
);

CREATE INDEX IF NOT EXISTS idx_data_source_health_project
  ON data_source_health (project_id);

CREATE INDEX IF NOT EXISTS idx_data_source_health_status
  ON data_source_health (status)
  WHERE status <> 'ok';
