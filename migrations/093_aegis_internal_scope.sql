-- Migration 093:
--   Обучение Эгиды как «своего мозга» только на наших продуктах (задача 2).
--
--   Идея: всё, что Эгида учит, должно происходить только на данных,
--   которые сгенерированы или измерены внутри наших продуктов
--   (project_analyses, отчёты, генерации), а не на внешнем RAG-контенте
--   конкурентов. Для этого:
--     1) во всех «датасетных» таблицах вводим колонку
--        aegis_source_scope ∈ {internal_product, external_rag};
--     2) при тренировке/оптимизации фильтр WHERE aegis_source_scope = 'internal_product';
--     3) новая таблица aegis_internal_observations накапливает связку
--        «снимок проекта + сделанная рекомендация + предсказанный KPI +
--        измеренный outcome» — будущая обучающая выборка для DSPy.
--
--   Дублируется в backend/server.js ensureSchema().

-- ── aegis_source_scope: расширяем существующие таблицы датасета. ────
-- Если таблицы ещё нет (модуль Aegis не инициализирован) — пропускаем.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'aegis_dspy_dataset') THEN
    EXECUTE 'ALTER TABLE aegis_dspy_dataset
              ADD COLUMN IF NOT EXISTS aegis_source_scope TEXT NOT NULL DEFAULT ''internal_product''';
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_aegis_dspy_dataset_scope
              ON aegis_dspy_dataset (aegis_source_scope)';
  END IF;
END $$;

-- ── Наблюдения над проектами — будущая обучающая выборка мозга. ─────
CREATE TABLE IF NOT EXISTS aegis_internal_observations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis_id     UUID,                                 -- ссылка на конкретный project_analyses, если есть
  source          TEXT NOT NULL DEFAULT 'project_analysis',
  taken_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  features        JSONB,                                -- метрики/срезы на момент рекомендации (анонимизированы)
  recommendation  JSONB,                                -- что было предложено action_plan/rankingFactors
  predicted_kpi   JSONB,                                -- ожидаемый эффект
  outcome         JSONB,                                -- фактический результат через N дней (NULL пока нет данных)
  reward          NUMERIC,                              -- кэш итогового reward (см. rewardCalculator)
  outcome_at      TIMESTAMPTZ,
  scope           TEXT NOT NULL DEFAULT 'internal_product',
  contribute      BOOLEAN NOT NULL DEFAULT TRUE,        -- копия projects.contribute_to_brain на момент записи
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aegis_internal_obs_project
  ON aegis_internal_observations (project_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_internal_obs_outcome_pending
  ON aegis_internal_observations (taken_at)
  WHERE outcome IS NULL;
CREATE INDEX IF NOT EXISTS idx_aegis_internal_obs_scope
  ON aegis_internal_observations (scope, contribute)
  WHERE outcome IS NOT NULL;
