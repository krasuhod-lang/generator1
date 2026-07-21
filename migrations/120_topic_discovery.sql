-- =================================================================
-- Migration 120: M-1 Topic Discovery result (InfoGapRadar)
-- =================================================================
-- Итерация 2, Задача 1.3: результат M-1 Topic Discovery записывается в
-- info_article_tasks / link_article_tasks для метаданных статьи и
-- последующего обучения AEGIS (Phase 5 dataset).
--
-- JSON-контракт (см. topicDiscovery.service._normalizeResult):
--   { topic_state, topic_score, go_decision, sub_niche_suggestions[],
--     manual_review, reasoning, signals_used, collected_at }
-- =================================================================

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS topic_discovery JSONB;

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS topic_discovery JSONB;
