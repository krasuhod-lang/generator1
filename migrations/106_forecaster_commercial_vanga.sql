-- Migration 106: строгий коммерческий фильтр + «Ванга» (Gemini бизнес-саммари).
--
-- error_code — машиночитаемый код ошибки для фронта (status остаётся 'error').
--   Пример: 'failed_no_commercial_intent' — при включённом commercial_only
--   в списке не осталось коммерческих запросов; фронт показывает
--   «В вашем списке нет коммерческих запросов» вместо технической ошибки.
--
-- vanga_summary — результат runVangaSummary (лаконичное бизнес-саммари
--   прогноза, ≤800 символов): { verdict:'ok'|'skipped'|'error', text, ... }.
--   При сбое Gemini (429/500/timeout) вердикт 'skipped'/'error' — пайплайн
--   не прерывается, математический прогноз сохраняется.

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS error_code TEXT;

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS vanga_summary JSONB;
