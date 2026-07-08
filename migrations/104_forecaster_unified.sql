-- Migration 104: единая («перепрошитая») модель прогноза трафика.
--
-- unified_forecast хранит результат buildUnifiedForecast:
-- params (L0,T,C_yield,r,SOV_start,SOV_max,k,t0,δ,seasonal[12]),
-- retro[] (ретроданные), forecast[] (точки с value/lower/upper),
-- summary, explain (пояснения простым языком для бизнеса).

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS unified_forecast JSONB;
