-- Migration 028:
--   Хранилище регресс-отчёта валидатора writer'а (Phase 2 / С1).
--   Отчёт содержит per-pass массив { pass, stage, ts, count, issues[],
--   by_kind } и агрегаты { total_passes, initial_count, final_count,
--   fixed_kinds[], persistent_kinds[], new_kinds[] }.
--
--   Используется для аналитики корпуса задач: какие классы issues
--   регрессируют чаще всего, сколько проходов нужно для финального pass'а.
--
--   Колонка nullable; для новых задач заполняется всегда, для исторических
--   остаётся NULL.
--
--   Соответствует ensureSchema() в backend/server.js (idempotent ADD COLUMN).

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS validation_report JSONB;
