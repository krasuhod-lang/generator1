-- 151_api_ledger_task_indexes.sql
-- Additive only: indexes for bounded admin per-task usage reconciliation.

CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_trace_task
  ON admin_api_request_ledger(trace_task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_task_ref
  ON admin_api_request_ledger((COALESCE(task_id, trace_task_id)), created_at DESC);

-- The trace table is optional telemetry in older installations. Creating it is
-- safe and does not participate in task completion or content persistence.
CREATE TABLE IF NOT EXISTS pipeline_traces (
  id               BIGSERIAL PRIMARY KEY,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stage            TEXT,
  pipeline         TEXT NOT NULL DEFAULT 'seo',
  task_id          TEXT,
  model            TEXT,
  prompt_version   TEXT,
  input_tokens     BIGINT,
  output_tokens    BIGINT,
  duration_ms      BIGINT,
  quality_score    NUMERIC(8,2),
  triggered_refine BOOLEAN NOT NULL DEFAULT FALSE
);

ALTER TABLE pipeline_traces
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS stage TEXT,
  ADD COLUMN IF NOT EXISTS pipeline TEXT NOT NULL DEFAULT 'seo',
  ADD COLUMN IF NOT EXISTS task_id TEXT,
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS input_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS output_tokens BIGINT,
  ADD COLUMN IF NOT EXISTS duration_ms BIGINT,
  ADD COLUMN IF NOT EXISTS quality_score NUMERIC(8,2),
  ADD COLUMN IF NOT EXISTS triggered_refine BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_pipeline_traces_task
  ON pipeline_traces(task_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_pipeline_traces_created
  ON pipeline_traces(created_at DESC);
