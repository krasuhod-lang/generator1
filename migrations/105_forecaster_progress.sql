-- Migration 105: прогресс выполнения задачи прогнозатора.
--
-- progress хранит текущее состояние пайплайна для «ползунка» в UI:
--   { stage: 'arsenkin_seasonality', percent: 42,
--     label: 'Сбор сезонности…', detail: 'Собрано 40 из 120 фраз',
--     updated_at: '2026-07-08T13:00:00.000Z' }

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS progress JSONB;
