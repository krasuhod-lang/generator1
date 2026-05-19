-- Migration 034: keys.so signals + forecaster excluded-from-forecast summary.
--
-- keysso_signals — JSON с результатами интеграции keys.so:
--   { verdict: 'ok'|'skipped'|'error', reason?, requested, matched,
--     cache_hits, duration_ms, domain, region, engine,
--     aggregate: { avg_current_position, phrases_in_top10_pct,
--                  phrases_in_top30_pct, phrases_off_top50_pct,
--                  median_competition, momentum, momentum_delta_avg } }
--
-- Используется trafficModel.js (калибровка CTR и realisticShareTopN по
-- сигналам выдачи) и deepseekAnalyzer.js (контекст в user-промт).
-- Подробнее: backend/src/services/forecaster/keyssoClient.js.
--
-- excluded_summary хранится внутри monthly_series JSONB (не требует колонки).

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS keysso_signals JSONB;
