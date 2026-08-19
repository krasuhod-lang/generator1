-- Complete lifecycle values used by the SEO generator pause/resume flow.
-- PostgreSQL enum additions are idempotent and safe for existing volumes.

ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'pausing';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'paused';
ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelled';
