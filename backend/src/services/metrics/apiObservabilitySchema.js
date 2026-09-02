/**
 * Migration 142 is mounted into PostgreSQL initdb, which only runs for a fresh
 * data volume. Existing production volumes therefore need the same idempotent
 * observability DDL at application startup.
 *
 * This schema is deliberately isolated from generation semantics: if the
 * ledger cannot be created, the application can still start, while the admin
 * endpoint reports a visible schema-unavailable error instead of fake zeros.
 */
const dbDefault = require('../../config/db');

async function ensureApiObservabilitySchema(db = dbDefault) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS admin_api_request_ledger (
      id                 BIGSERIAL PRIMARY KEY,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider           TEXT NOT NULL,
      model              TEXT,
      pipeline           TEXT,
      stage_name         TEXT,
      call_label         TEXT,
      task_id            UUID,
      trace_task_id      UUID,
      request_status     TEXT NOT NULL DEFAULT 'success',
      http_status        INTEGER,
      attempt            INTEGER NOT NULL DEFAULT 1,
      duration_ms        BIGINT,
      prompt_size        BIGINT,
      tokens_in          BIGINT NOT NULL DEFAULT 0,
      tokens_out         BIGINT NOT NULL DEFAULT 0,
      cached_tokens      BIGINT NOT NULL DEFAULT 0,
      cache_hit_tokens   BIGINT NOT NULL DEFAULT 0,
      cache_miss_tokens  BIGINT NOT NULL DEFAULT 0,
      thoughts_tokens    BIGINT NOT NULL DEFAULT 0,
      input_cost_usd     NUMERIC(18,12) NOT NULL DEFAULT 0,
      output_cost_usd    NUMERIC(18,12) NOT NULL DEFAULT 0,
      cost_usd           NUMERIC(18,12) NOT NULL DEFAULT 0,
      error_code         TEXT,
      error_message      TEXT,
      meta               JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `ALTER TABLE admin_api_request_ledger
       ADD COLUMN IF NOT EXISTS model TEXT,
       ADD COLUMN IF NOT EXISTS pipeline TEXT,
       ADD COLUMN IF NOT EXISTS stage_name TEXT,
       ADD COLUMN IF NOT EXISTS call_label TEXT,
       ADD COLUMN IF NOT EXISTS task_id UUID,
       ADD COLUMN IF NOT EXISTS trace_task_id UUID,
       ADD COLUMN IF NOT EXISTS request_status TEXT NOT NULL DEFAULT 'success',
       ADD COLUMN IF NOT EXISTS http_status INTEGER,
       ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 1,
       ADD COLUMN IF NOT EXISTS duration_ms BIGINT,
       ADD COLUMN IF NOT EXISTS prompt_size BIGINT,
       ADD COLUMN IF NOT EXISTS tokens_in BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS tokens_out BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS cached_tokens BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS thoughts_tokens BIGINT NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS input_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS output_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS error_code TEXT,
       ADD COLUMN IF NOT EXISTS error_message TEXT,
       ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_created
       ON admin_api_request_ledger(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_provider_model
       ON admin_api_request_ledger(provider, model, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_task
       ON admin_api_request_ledger(task_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_trace_task
       ON admin_api_request_ledger(trace_task_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_task_ref
       ON admin_api_request_ledger((COALESCE(task_id, trace_task_id)), created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_status
       ON admin_api_request_ledger(request_status, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS pipeline_traces (
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
    )`,
    `ALTER TABLE pipeline_traces
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
       ADD COLUMN IF NOT EXISTS triggered_refine BOOLEAN NOT NULL DEFAULT FALSE`,
    `CREATE INDEX IF NOT EXISTS ix_pipeline_traces_task
       ON pipeline_traces(task_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_pipeline_traces_created
       ON pipeline_traces(created_at DESC)`,
  ];

  for (const sql of statements) await db.query(sql);
  console.log('[Schema] admin_api_request_ledger ready');
}

module.exports = { ensureApiObservabilitySchema };
