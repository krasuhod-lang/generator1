-- Additive writing profile contract for all content generators.
-- Existing tasks retain their data and receive an empty profile object.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS writing_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS writing_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS writing_profile_json JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS ix_tasks_writing_profile
  ON tasks USING GIN (writing_profile_json);

CREATE INDEX IF NOT EXISTS ix_info_article_tasks_writing_profile
  ON info_article_tasks USING GIN (writing_profile_json);

CREATE INDEX IF NOT EXISTS ix_link_article_tasks_writing_profile
  ON link_article_tasks USING GIN (writing_profile_json);
