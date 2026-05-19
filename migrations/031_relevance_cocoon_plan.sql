-- =================================================================
-- Migration 031: Relevance — cocoon_plan (Bourrelly cocoon)
-- =================================================================
-- Добавляет колонку cocoon_plan в relevance_reports для хранения
-- результата POST /api/relevance/:id/cocoon-plan.
--
-- В отличие от cocoons (TruncatedSVD/LSA по чужим документам), здесь
-- хранится план НАШЕГО будущего сайта: Page Cible → Mères → Filles
-- + граф перелинковки по золотым правилам Bourrelly:
--   {generated_at, duration_ms, options, plan, markdown}
-- Идемпотентно перезаписывается при каждом вызове endpoint'а.
-- =================================================================

ALTER TABLE relevance_reports
  ADD COLUMN IF NOT EXISTS cocoon_plan JSONB;
