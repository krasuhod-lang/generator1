-- Migration 037: quality_score JSONB column for info_article_tasks / link_article_tasks.
--
-- Хранит детерминированный агрегат качества генерации, считаемый
-- backend/src/services/qualityLayers/qualityScore.js по уже существующим
-- отчётам (eeat_audit, readability_report, intent_verdict, fact_check_report,
-- plagiarism_report, lsi_*_report, validation_report, image_qa_report).
--
-- Формат: { overall:0..100, sub:{...}, model_used, cost_usd,
--           generation_time_ms, computed_at }.
--
-- Используется:
--   • GET /api/admin/model-comparison — таблица «модель × средний score»;
--   • qualityFeedback.js (P6.1) — выявление аномально низких score;
--   • UI «Сравнение моделей».
--
-- Колонка nullable: исторические задачи остаются с NULL до пересчёта.

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS quality_score JSONB;
ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS quality_score JSONB;

-- Индекс для быстрых аналитических выборок по модели.
CREATE INDEX IF NOT EXISTS info_article_quality_score_model_idx
  ON info_article_tasks ((quality_score->>'model_used'))
  WHERE quality_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS link_article_quality_score_model_idx
  ON link_article_tasks ((quality_score->>'model_used'))
  WHERE quality_score IS NOT NULL;
