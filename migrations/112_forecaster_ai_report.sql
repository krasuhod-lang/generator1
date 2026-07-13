-- Migration 112: AI-аналитика прогноза + граф охвата семантики.
--
-- ai_report — структурированный аналитический отчёт LLM (forecastReport.js):
--   { verdict:'ok'|'skipped'|'error'|'generating', report:{ executive_summary,
--     growth_narrative, semantic_gap_analysis, top_opportunities[], risks[],
--     action_plan[], confidence_comment }, model, tokens_in, tokens_out, cost_usd }.
--   Генерируется fire-and-forget при финализации задачи; при сбое LLM задача
--   всё равно помечается done, ai_report остаётся null/error. Перегенерация —
--   POST /api/forecaster/:id/regenerate-report.
--
-- semantic_distribution — time-series распределения семантики по топам
--   (buildSemanticDistribution в trafficModel.js): по каждому месяцу прогноза
--   { month, label, period, distribution:{top3,top10,top20,out:{count,volume}},
--     traffic_realistic, traffic_optimistic }. Данные для графика
--   SemanticCoverageChart.vue (замена статичных карточек ТОП-3/5/10).

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS ai_report JSONB;

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS semantic_distribution JSONB;
