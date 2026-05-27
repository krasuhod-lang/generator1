-- Migration 053: source_relevance_report_id on link_article_tasks / meta_tag_tasks.
--
-- Sprint B (Relevance → generators): даёт возможность привязать задачу
-- ссылочной статьи или мета-тегов к готовому отчёту релевантности. Pipeline
-- подгружает relevance-артефакт (LSI / n-граммы / H2-H3-наброски /
-- competitor_signals) и инжектит его в user-prompt'ы, чтобы:
--   • linkArticle: writer обязательно использовал LSI и раскрыл темы из H2;
--   • metaTags: title/description содержали важные n-граммы топа.
--
-- BC: колонка nullable; если null — pipeline ведёт себя как прежде.

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID;

CREATE INDEX IF NOT EXISTS idx_link_article_tasks_relevance_src
  ON link_article_tasks (source_relevance_report_id)
  WHERE source_relevance_report_id IS NOT NULL;

ALTER TABLE meta_tag_tasks
  ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID;

CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_relevance_src
  ON meta_tag_tasks (source_relevance_report_id)
  WHERE source_relevance_report_id IS NOT NULL;
