-- Migration 023:
--   Хранилище отчёта детерминированной фактологической проверки (Phase 1 / P0-1).
--   Отчёт содержит summary (total/supported/partial/unsupported/verdict),
--   top_unsupported / top_partial и полный results[] для UI / audit-trail.
--
--   Колонка nullable — задачи без grounding'а или со старыми пайплайнами
--   её просто не заполняют.
--
--   Соответствует ensureSchema() в backend/server.js — этот файл нужен для
--   ручного применения вне Node.

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS fact_check_report JSONB;
