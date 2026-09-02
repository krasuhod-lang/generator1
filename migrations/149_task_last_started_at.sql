-- Preserve the original created_at while tracking the latest execution attempt.
-- This prevents reruns/recovery from appearing under an unrelated historical day.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS content_stale BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_tasks_user_last_started
  ON tasks (user_id, last_started_at DESC NULLS LAST, created_at DESC);

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ;
ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS last_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_info_article_tasks_user_last_started
  ON info_article_tasks (user_id, last_started_at DESC NULLS LAST, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_link_article_tasks_user_last_started
  ON link_article_tasks (user_id, last_started_at DESC NULLS LAST, created_at DESC);

UPDATE info_article_tasks
   SET last_started_at = started_at
 WHERE last_started_at IS NULL
   AND started_at IS NOT NULL;
UPDATE link_article_tasks
   SET last_started_at = started_at
 WHERE last_started_at IS NULL
   AND started_at IS NOT NULL;

UPDATE tasks
   SET last_started_at = started_at
 WHERE last_started_at IS NULL
   AND started_at IS NOT NULL;

COMMENT ON COLUMN tasks.last_started_at IS
  'Timestamp of the latest explicit or recovered generation attempt; created_at remains immutable creation time.';
COMMENT ON COLUMN tasks.content_stale IS
  'The saved result remains available but no longer matches edited inputs until the next successful generation.';
COMMENT ON COLUMN info_article_tasks.last_started_at IS
  'Timestamp of the latest generation attempt; started_at remains the first start time.';
COMMENT ON COLUMN link_article_tasks.last_started_at IS
  'Timestamp of the latest generation attempt; started_at remains the first start time.';

-- Keep this migration additive-only: no task rows, content, metrics, or users are deleted.
