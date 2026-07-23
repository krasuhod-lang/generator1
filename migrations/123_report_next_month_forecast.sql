-- Migration 123: прогноз роста отчёта на следующий месяц (TZ_Reports_Fixes §6)

ALTER TABLE report_drafts
  ADD COLUMN IF NOT EXISTS llm_next_month_forecast TEXT;
