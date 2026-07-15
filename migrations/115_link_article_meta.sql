-- =================================================================
-- Migration 115: Link Article Meta Tags (GIST Meta Filter)
-- =================================================================
-- Задача D: мета-теги (title/description) для ссылочных статей,
-- сгенерированные GIST Meta Filter Pipeline, чтобы их можно было
-- копировать отдельно от статьи. JSON-контракт §8 ТЗ:
-- { title, description, description_mobile, h1, winner_fact,
--   winner_source, scores, conflict_check, replaceability_check,
--   temporary_gist_factor, review_date, manual_review_required, ... }
-- =================================================================

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS meta_tags JSONB;
