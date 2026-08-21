-- Distributed per-user task admission.
-- One user may hold at most five live leases across API/worker processes.
CREATE TABLE IF NOT EXISTS user_task_slot_leases (
  slot_token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  task_id TEXT NOT NULL,
  lease_until TIMESTAMPTZ NOT NULL,
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, task_type, task_id)
);

CREATE INDEX IF NOT EXISTS idx_user_task_slot_leases_active
  ON user_task_slot_leases(user_id, lease_until);

CREATE INDEX IF NOT EXISTS idx_user_task_slot_leases_expiry
  ON user_task_slot_leases(lease_until);
