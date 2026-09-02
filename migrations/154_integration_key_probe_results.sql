-- 154_integration_key_probe_results.sql
-- Safe metadata only: no plaintext secret, response body or provider error payload.
CREATE TABLE IF NOT EXISTS admin_integration_key_probe_results (
  env_name       TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  active         BOOLEAN,
  probe_supported BOOLEAN NOT NULL DEFAULT FALSE,
  http_status    INTEGER,
  latency_ms     INTEGER,
  message        TEXT,
  checked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_admin_key_probe_checked
  ON admin_integration_key_probe_results(checked_at DESC);

COMMENT ON TABLE admin_integration_key_probe_results IS
  'Last non-secret provider probe metadata for admin integration keys.';
