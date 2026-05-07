-- Migration 022:
--   1) Связь задачи генерации (SEO-текст / Статья в блог) с исходным
--      отчётом релевантности — чтобы pipeline мог влить
--      `mandatory_entities` и `competitor_signals` в __moduleContext / IAKB.
--   2) Управляемое пользователем количество изображений для info-article
--      (по бизнес-требованию: «Делается только для статьи в блог»).
--
-- Соответствует ensureSchema() в backend/server.js — этот файл нужен для
-- ручного применения вне Node.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID
    REFERENCES relevance_reports(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_source_relevance
  ON tasks (source_relevance_report_id)
  WHERE source_relevance_report_id IS NOT NULL;

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS source_relevance_report_id UUID
    REFERENCES relevance_reports(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS images_count INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_info_article_source_relevance
  ON info_article_tasks (source_relevance_report_id)
  WHERE source_relevance_report_id IS NOT NULL;

-- Защитный CHECK: 1..6 изображений — выше штучного количества
-- pipeline не пойдёт (visualPlanner / Stage 4 проектировались под 1 cover,
-- сейчас даём диапазон 1..6 как разумный максимум для info-article).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'info_article_tasks_images_count_chk'
  ) THEN
    ALTER TABLE info_article_tasks
      ADD CONSTRAINT info_article_tasks_images_count_chk
      CHECK (images_count BETWEEN 1 AND 6);
  END IF;
END$$;
