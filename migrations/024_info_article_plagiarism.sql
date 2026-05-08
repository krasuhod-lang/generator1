-- Migration 024:
--   Хранилище отчёта детерминированной анти-плагиат проверки (Phase 1 / P0-3).
--   Отчёт содержит summary (overlap_pct_total, counts, verdict),
--   index_stats, top_sentences (с per-sentence donors) и top_donors.
--
--   Колонка nullable — задачи без grounding'а или со старыми пайплайнами
--   её просто не заполняют.
--
--   Соответствует ensureSchema() в backend/server.js — этот файл нужен для
--   ручного применения вне Node.

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS plagiarism_report JSONB;
