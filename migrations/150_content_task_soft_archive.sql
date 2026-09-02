-- Keep blog/link task rows and generated content recoverable after a user delete action.
-- The archive is additive-only and does not remove task data or filesystem artifacts.
ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID;

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by UUID;

CREATE INDEX IF NOT EXISTS idx_info_article_user_archived
  ON info_article_tasks (user_id, archived_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_article_user_archived
  ON link_article_tasks (user_id, archived_at, created_at DESC);

COMMENT ON COLUMN info_article_tasks.archived_at IS
  'Soft archive timestamp; generated article and task row remain available to the owner/admin.';
COMMENT ON COLUMN link_article_tasks.archived_at IS
  'Soft archive timestamp; generated article and task row remain available to the owner/admin.';
