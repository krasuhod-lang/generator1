-- Migration 035: forecaster advanced analytics (opportunities + DSPy experts + leads).
--
-- Добавляет три JSONB-колонки в forecaster_tasks:
--   opportunities      — результат opportunityAnalyzer.analyzeOpportunities()
--                        { verdict, opportunities[], clusters[], summary, calibration }
--   expert_reports     — { niche_strategist:{verdict,payload,…},
--                          opportunity_hunter:{verdict,payload,…},
--                          cluster_planner:{verdict,payload,…} }
--   leads_summary      — компактная сводка leads-модели (CR, current_leads, top3/5/10 lead totals);
--                        дублируется в traffic_estimate.leads_model для удобства фронта.
--
-- Расширенная аналитика гейтуется forecaster.advanced.enabled (default true);
-- если выключена, колонки остаются NULL. DSPy-эксперты graceful skip без DEEPSEEK_API_KEY.

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS opportunities    JSONB,
  ADD COLUMN IF NOT EXISTS expert_reports   JSONB,
  ADD COLUMN IF NOT EXISTS leads_summary    JSONB;
