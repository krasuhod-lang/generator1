-- ============================================================================
-- 117: TZ Binding для SEO-пайплайна (Task C)
--
-- tasks — основной SEO-пайплайн (см. 001_initial_schema.sql).
-- tz_json хранит нормализованное ТЗ, tz_source — источник, tz_compliance —
-- детерминированный отчёт Stage 7 по соблюдению обязательных требований.
-- ============================================================================

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tz_json JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tz_source VARCHAR(50); -- 'relevance_tool' | 'manual' | 'auto'
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tz_compliance JSONB;
