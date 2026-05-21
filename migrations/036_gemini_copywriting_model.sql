-- =================================================================
-- Migration 036: per-task Gemini copywriting model selector
-- =================================================================
-- Internal selector for Gemini text models used by copywriting tasks.
-- No new ENV variables are required: each task stores the selected model.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview';

ALTER TABLE meta_tag_tasks
  ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview';

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview';

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview';

ALTER TABLE article_topic_tasks
  ADD COLUMN IF NOT EXISTS gemini_model TEXT NOT NULL DEFAULT 'gemini-3.1-pro-preview';

DO $$
DECLARE
  tbl TEXT;
  constraint_name TEXT;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['tasks','meta_tag_tasks','link_article_tasks','info_article_tasks','article_topic_tasks']
  LOOP
    constraint_name := tbl || '_gemini_model_check';
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint WHERE conname = constraint_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (gemini_model IN (%L, %L))',
        tbl,
        constraint_name,
        'gemini-3.1-pro-preview',
        'gemini-3.5-flash'
      );
    END IF;
  END LOOP;
END$$;
