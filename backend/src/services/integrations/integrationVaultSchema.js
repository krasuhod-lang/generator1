'use strict';

const dbDefault = require('../../config/db');

/**
 * Migration 143 is also mounted into initdb, but existing PostgreSQL volumes
 * do not execute init scripts again. Keep the additive DDL here so a normal
 * deploy repairs the vault schema without dropping any data.
 */
async function ensureIntegrationVaultSchema(db = dbDefault) {
  const statements = [
    `CREATE TABLE IF NOT EXISTS admin_integration_secrets (
      id              BIGSERIAL PRIMARY KEY,
      env_name        TEXT NOT NULL UNIQUE,
      encrypted_value TEXT,
      is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      last_rotated_at TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE admin_integration_secrets
       ADD COLUMN IF NOT EXISTS encrypted_value TEXT,
       ADD COLUMN IF NOT EXISTS is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
       ADD COLUMN IF NOT EXISTS last_rotated_at TIMESTAMPTZ,
       ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `CREATE TABLE IF NOT EXISTS admin_integration_secret_audit (
      id            BIGSERIAL PRIMARY KEY,
      env_name      TEXT NOT NULL,
      action        TEXT NOT NULL,
      admin_user_id TEXT,
      masked_value  TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb
    )`,
    `ALTER TABLE admin_integration_secret_audit
       ADD COLUMN IF NOT EXISTS admin_user_id TEXT,
       ADD COLUMN IF NOT EXISTS masked_value TEXT,
       ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE admin_integration_secret_audit
       ALTER COLUMN admin_user_id TYPE TEXT
       USING admin_user_id::text`,
    `CREATE INDEX IF NOT EXISTS ix_admin_integration_secret_audit_created
       ON admin_integration_secret_audit(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS ix_admin_integration_secret_audit_env
       ON admin_integration_secret_audit(env_name, created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS admin_integration_key_probe_results (
      env_name        TEXT PRIMARY KEY,
      status          TEXT NOT NULL,
      active          BOOLEAN,
      probe_supported BOOLEAN NOT NULL DEFAULT FALSE,
      http_status     INTEGER,
      latency_ms      INTEGER,
      message         TEXT,
      checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    `ALTER TABLE admin_integration_key_probe_results
       ADD COLUMN IF NOT EXISTS status TEXT,
       ADD COLUMN IF NOT EXISTS active BOOLEAN,
       ADD COLUMN IF NOT EXISTS probe_supported BOOLEAN NOT NULL DEFAULT FALSE,
       ADD COLUMN IF NOT EXISTS http_status INTEGER,
       ADD COLUMN IF NOT EXISTS latency_ms INTEGER,
       ADD COLUMN IF NOT EXISTS message TEXT,
       ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `CREATE INDEX IF NOT EXISTS ix_admin_key_probe_checked
       ON admin_integration_key_probe_results(checked_at DESC)`,
  ];
  for (const sql of statements) await db.query(sql);
  console.log('[Schema] admin integration secret vault ready');
}

module.exports = { ensureIntegrationVaultSchema };
