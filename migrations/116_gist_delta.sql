-- ============================================================================
-- 116: GIST Delta JSON для info_article_tasks (Task B)
--
-- Храним отдельный артефакт Stage 1B/5C: information_delta, top10_claims,
-- gist_score, SERP-источники Google и итоговый coverage_score аудита.
-- ============================================================================

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS gist_delta_json JSONB;
