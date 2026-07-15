-- Migration 118: GIST delta for link-article pipeline.
ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS gist_delta_json JSONB;
