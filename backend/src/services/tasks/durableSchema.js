'use strict';

const dbDefault = require('../../config/db');

/**
 * Runtime-safe mirror of the durable execution migrations 130–132.
 * Docker init scripts only run for a fresh PostgreSQL volume, therefore the
 * running application must apply these idempotent statements on old volumes.
 */
async function ensureDurableTaskSchema(db = dbDefault) {
  const statements = [
    `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
    `ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'pausing'`,
    `ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'paused'`,
    `ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelled'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checkpoint_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_reliability_recovery ON tasks(status, lease_until) WHERE status IN ('queued','processing')`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_generation_profile_active ON tasks(user_id, status, lease_until) WHERE status IN ('queued','processing')`,

    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS input_urls JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS dispatch_job_id TEXT`,

    `CREATE TABLE IF NOT EXISTS parser_task_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES parser_tasks(id) ON DELETE CASCADE,
      input_url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      lease_token UUID,
      lease_until TIMESTAMPTZ,
      heartbeat_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      checkpoint JSONB,
      result JSONB,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      UNIQUE (task_id, normalized_url)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parser_task_items_queue ON parser_task_items(status, next_attempt_at, lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_task_items_task_status ON parser_task_items(task_id, status)`,

    `CREATE TABLE IF NOT EXISTS generator_task_outbox (
      id BIGSERIAL PRIMARY KEY,
      queue_name TEXT NOT NULL,
      job_name TEXT NOT NULL,
      job_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (queue_name, job_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_generator_task_outbox_pending ON generator_task_outbox(available_at, id) WHERE published_at IS NULL`,

    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `CREATE INDEX IF NOT EXISTS idx_site_crawl_tasks_recovery ON site_crawl_tasks(status, lease_until) WHERE status IN ('queued','running')`,

    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS python_task_id TEXT`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `UPDATE audit_tasks SET python_task_id=id::text WHERE python_task_id IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_audit_tasks_recovery ON audit_tasks(status, lease_until) WHERE status IN ('pending','running')`,
  ];

  for (const sql of statements) await db.query(sql);
}

module.exports = { ensureDurableTaskSchema };
