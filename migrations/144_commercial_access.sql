-- Commercial access foundation.
-- Additive and safe for existing PostgreSQL volumes; no task/report data is changed.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS user_access_profiles (
  user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  account_role  VARCHAR(20) NOT NULL DEFAULT 'client'
    CHECK (account_role IN ('admin', 'employee', 'client')),
  plan_key      VARCHAR(20) NOT NULL DEFAULT 'trial'
    CHECK (plan_key IN ('trial', 'minimal', 'medium', 'pro', 'internal')),
  status        VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'expired')),
  period_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  period_end    TIMESTAMPTZ,
  overrides     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end IS NULL OR period_end > period_start)
);

CREATE INDEX IF NOT EXISTS idx_user_access_profiles_role
  ON user_access_profiles(account_role);
CREATE INDEX IF NOT EXISTS idx_user_access_profiles_active_period
  ON user_access_profiles(status, period_end);

-- Legacy role='admin' remains the strict adminAuth source of truth. The new
-- account_role is the normal user-facing RBAC field. Existing regular users
-- receive only the five-generation trial, never a paid entitlement.
INSERT INTO user_access_profiles (user_id, account_role, plan_key, status, period_start, period_end, overrides)
SELECT id,
       CASE WHEN role = 'admin' THEN 'admin' ELSE 'client' END,
       CASE WHEN role = 'admin' THEN 'internal' ELSE 'trial' END,
       'active',
       COALESCE(created_at, NOW()),
       NULL,
       '{}'::jsonb
  FROM users
 WHERE NOT EXISTS (
   SELECT 1 FROM user_access_profiles p WHERE p.user_id = users.id
 );

CREATE TABLE IF NOT EXISTS access_usage_reservations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_key    VARCHAR(120) NOT NULL,
  resource_key  VARCHAR(40) NOT NULL,
  source        VARCHAR(80) NOT NULL,
  task_id       VARCHAR(160) NOT NULL,
  item_index    INTEGER NOT NULL DEFAULT 0 CHECK (item_index >= 0),
  units         INTEGER NOT NULL CHECK (units > 0),
  state         VARCHAR(20) NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved', 'consumed', 'released')),
  reserved_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at   TIMESTAMPTZ,
  released_at   TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, period_key, resource_key, source, task_id, item_index)
);

CREATE INDEX IF NOT EXISTS idx_access_usage_period_resource
  ON access_usage_reservations(user_id, period_key, resource_key, state);
CREATE INDEX IF NOT EXISTS idx_access_usage_task
  ON access_usage_reservations(user_id, source, task_id);

COMMENT ON TABLE user_access_profiles IS
  'Admin-managed RBAC, plan assignment, period and typed commercial overrides.';
COMMENT ON TABLE access_usage_reservations IS
  'Idempotent append-only-ish quota reservation ledger; released rows are retained for audit.';
