-- Migration 090: «Защита от каннибализации» — поле исключений в темах статей.
--
-- exclude_topics       — пользовательский ввод. JSONB-массив объектов:
--   [{ "raw": "...", "kind": "topic" | "cluster", "canon": "..." }]
-- exclusion_sources    — итоговый exclusion-set, реально подмешанный в
--   промт + статистика отбраковки (для UI). Структура:
--   {
--     "user_topics":   [...],
--     "user_clusters": [...],
--     "history":       [...],
--     "cannibalization": [...],
--     "target_url_h1": "...",
--     "dropped_by_semantic": [ { title, reason, matched } ]
--   }
--
-- Оба поля NULL для совместимости со старыми задачами.

ALTER TABLE article_topic_tasks
  ADD COLUMN IF NOT EXISTS exclude_topics    JSONB,
  ADD COLUMN IF NOT EXISTS exclusion_sources JSONB;
