-- Migration 096: RL feedback source rename GA4 → Search Console + Яндекс.Вебмастер.
--
-- У нас нет и не предусмотрено Google Analytics. Реальный per-URL CTR-сигнал
-- для RL/PPO-контура теперь берётся из уже интегрированных источников проекта:
-- Google Search Console (per-URL) + Яндекс.Вебмастер (host-level).
--
-- Колонка aegis_dspy_dataset.ga4_metrics переименовывается в feedback_metrics
-- и хранит {source, ctr, clicks, impressions}. Существующие строки сохраняются
-- (RENAME COLUMN не теряет данные). Идемпотентно: если колонка уже
-- переименована — no-op.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'aegis_dspy_dataset' AND column_name = 'ga4_metrics'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'aegis_dspy_dataset' AND column_name = 'feedback_metrics'
  ) THEN
    EXECUTE 'ALTER TABLE aegis_dspy_dataset RENAME COLUMN ga4_metrics TO feedback_metrics';
  END IF;
END $$;

-- На случай, если таблица создаётся заново без legacy-колонки.
ALTER TABLE aegis_dspy_dataset ADD COLUMN IF NOT EXISTS feedback_metrics JSONB;
