-- =================================================================
-- Migration 127: SEO мета-теги основного пайплайна (Stage 7.5)
--
-- До этой миграции мета-теги основного SEO-пайплайна не сохранялись нигде:
-- колонки под них были только у info_article_tasks (миграция 057). Stage 7.5
-- (orchestrator) вызывает единый движок GIST Meta Filter через metaFacade и
-- пишет результат сюда.
--
--   seo_title       — итоговый Title (кириллический safe range 70–80)
--   seo_description — итоговый Description (180–190)
--   seo_meta        — полный отчёт: H1, GIST-факт, CTR-скор, ноты, lsi_check
--
-- Идемпотентно (IF NOT EXISTS), по образцу 057.
-- =================================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seo_title       TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seo_description TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS seo_meta        JSONB;

COMMENT ON COLUMN tasks.seo_title       IS 'SEO Title (Stage 7.5, GIST Meta Filter)';
COMMENT ON COLUMN tasks.seo_description IS 'SEO Description (Stage 7.5, GIST Meta Filter)';
COMMENT ON COLUMN tasks.seo_meta        IS 'Полный отчёт генерации мета-тегов: h1, gist_fact, ctr_score, notes';

-- Отчёт генерации мета-тегов для статей блога (тот же контракт metaFacade).
ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS seo_meta_report JSONB;

COMMENT ON COLUMN info_article_tasks.seo_meta_report IS 'Отчёт metaFacade: source, gist_fact, ctr_score, notes';
