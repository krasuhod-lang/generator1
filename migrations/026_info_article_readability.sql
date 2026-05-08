-- Migration 026:
--   Хранилище отчёта программного анализатора читабельности (Phase 2 / Б4).
--   Отчёт содержит metrics (flesch_index, avg_sentence_words, long_sentence_pct,
--   bureaucratese_pct, passive_pct, sentence_count, word_count, char_count),
--   issues[] (kind, message, severity), thresholds и verdict
--   (pass | review | refine | na).
--
--   Колонка nullable: если INFO_ARTICLE_READABILITY_ENABLED=false или статья
--   слишком короткая (verdict=na) — поле остаётся NULL.
--
--   Соответствует ensureSchema() в backend/server.js (idempotent ADD COLUMN).

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS readability_report JSONB;
