-- Migration 103: SOV-прогноз (доля рынка / Share of Voice) для «Прогнозатора».
--
-- sov_forecast хранит сценарный прогноз трафика/лидов по доле рынка:
-- constants, periods, scenarios.{pessimistic,realistic,optimistic}, summary.

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS sov_forecast JSONB;
