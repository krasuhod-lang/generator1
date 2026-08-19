-- Per-profile admission control for the main SEO text generator.
-- A profile is the authenticated users.id value. At most five tasks for the
-- same profile may hold an active generation lease; all other tasks remain
-- queued and are retried fairly by BullMQ.

CREATE INDEX IF NOT EXISTS idx_tasks_generation_profile_active
  ON tasks(user_id, status, lease_until)
  WHERE status IN ('queued', 'processing');
