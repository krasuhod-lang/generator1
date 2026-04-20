-- =================================================================
-- Migration 005: Add pause/resume support for pipeline tasks
-- =================================================================

-- Add new statuses to task_status enum
-- (PostgreSQL does not support IF NOT EXISTS for ADD VALUE, so we use DO blocks)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'pausing'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'task_status')
  ) THEN
    ALTER TYPE task_status ADD VALUE 'pausing';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'paused'
      AND enumtypid = (SELECT oid FROM pg_type WHERE typname = 'task_status')
  ) THEN
    ALTER TYPE task_status ADD VALUE 'paused';
  END IF;
END$$;

-- Add pipeline_checkpoint column for storing resume state
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS pipeline_checkpoint JSONB;

-- Index for quick lookup of paused/pausing tasks
CREATE INDEX IF NOT EXISTS idx_tasks_pause_status
  ON tasks(status)
  WHERE status IN ('paused', 'pausing');
