-- Migration 089: «Проект как живой контейнер задач» — Этап 1.
--
-- 1. В projects добавляем «контент-параметры» (год, валюта, ценовой ориентир,
--    редакционные критерии) — они подмешиваются единым блоком КОНТЕКСТ
--    ПРОЕКТА во все промты задач, чтобы LLM использовала правильный год,
--    валюту, стоп-слова и обязательные дисклеймеры независимо от того, кто
--    создаёт задачу.
--
-- 2. Во все task-таблицы добавляем project_context_snapshot JSONB —
--    компактный слепок контекста проекта на момент создания задачи
--    (только то, что реально ушло в промт). Нужен:
--      • для воспроизводимости и аудита (что именно увидела модель);
--      • для UI-плашки «context от <дата>, текущие настройки могли
--        измениться» (см. ТЗ §1.3);
--      • для устойчивости при удалении проекта (ON DELETE SET NULL уже
--        стоит из миграции 087; деталка задачи отдаёт project_snapshot
--        вместо джойна с projects).
--
-- Размер слепка ограничивается на уровне кода (compactProjectSnapshot,
-- ≤ 32 КБ), но добавляем CHECK с двойным запасом (64 КБ) на случай
-- ручной правки JSON.

-- ─── projects: контент-параметры ──────────────────────────────────
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS default_year      INTEGER,
  ADD COLUMN IF NOT EXISTS default_currency  VARCHAR(16),
  ADD COLUMN IF NOT EXISTS pricing_notes     TEXT,
  ADD COLUMN IF NOT EXISTS content_criteria  JSONB;

-- ─── project_context_snapshot во все task-таблицы ─────────────────
-- compactProjectSnapshot жёстко режет до 32 КБ; БД даём 64 КБ запаса.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'info_article_tasks',
    'link_article_tasks',
    'meta_tag_tasks',
    'article_topic_tasks',
    'relevance_reports',
    'forecaster_tasks',
    'serp_b2b_tasks'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS project_context_snapshot JSONB',
        t
      );
      -- CHECK — best-effort, не падаем если PG версия не любит NULL в выражении.
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I
             ADD CONSTRAINT %I CHECK (
               project_context_snapshot IS NULL
               OR octet_length(project_context_snapshot::text) <= 65536
             )',
          t,
          'chk_' || t || '_ctx_size'
        );
      EXCEPTION
        WHEN duplicate_object THEN NULL;
        WHEN others THEN NULL; -- best-effort, не валим миграцию
      END;
    END IF;
  END LOOP;

  -- tasks и category_lead_tasks — необязательные.
  FOREACH t IN ARRAY ARRAY['tasks', 'category_lead_tasks'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format(
        'ALTER TABLE %I ADD COLUMN IF NOT EXISTS project_context_snapshot JSONB',
        t
      );
    END IF;
  END LOOP;
END $$;
