-- 141: SEO task integrity and canonical completion timeline.
-- Additive only: existing task rows, UUIDs and generated content are preserved.
-- The runtime bootstrap also applies these statements on existing volumes.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_user_completion
  ON tasks (user_id, completed_at DESC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project_completion
  ON tasks (project_id, completed_at DESC NULLS LAST, created_at DESC)
  WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_active_archive
  ON tasks (user_id, status, archived_at)
  WHERE archived_at IS NULL;

ALTER TABLE tasks_auto_log
  ADD COLUMN IF NOT EXISTS performed_at_ts TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS performed_at_source VARCHAR(32) NOT NULL DEFAULT 'legacy_fallback';

CREATE INDEX IF NOT EXISTS idx_tasks_auto_log_project_perf_ts
  ON tasks_auto_log (project_id, performed_at DESC, performed_at_ts DESC NULLS LAST);

-- Backfill only the new timestamp from the already preserved DATE value. The
-- exact original completion instant is unavailable for legacy log rows; those
-- rows remain explicitly marked as legacy_fallback rather than being presented
-- as precise timestamps.
UPDATE tasks_auto_log
   SET performed_at_ts = performed_at::timestamptz
 WHERE performed_at_ts IS NULL;
