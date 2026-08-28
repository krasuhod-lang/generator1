-- 143_admin_integration_secrets.sql
-- Central encrypted integration secret overrides for admin rotation.
-- Plaintext values are never stored; encryption happens in Node with AES-256-GCM.
CREATE TABLE IF NOT EXISTS admin_integration_secrets (
  id              BIGSERIAL PRIMARY KEY,
  env_name        TEXT NOT NULL UNIQUE,
  encrypted_value TEXT,
  is_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  last_rotated_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admin_integration_secret_audit (
  id            BIGSERIAL PRIMARY KEY,
  env_name      TEXT NOT NULL,
  action        TEXT NOT NULL,
  admin_user_id BIGINT,
  masked_value  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  meta          JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_admin_integration_secret_audit_created
  ON admin_integration_secret_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_admin_integration_secret_audit_env
  ON admin_integration_secret_audit(env_name, created_at DESC);

COMMENT ON TABLE admin_integration_secrets IS
  'Encrypted admin-managed integration secret overrides; plaintext never stored.';
COMMENT ON TABLE admin_integration_secret_audit IS
  'Append-only masked audit trail for integration secret rotation; never stores plaintext.';
