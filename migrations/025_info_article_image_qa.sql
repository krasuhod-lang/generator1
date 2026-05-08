-- Migration 025:
--   Хранилище отчёта детерминированной image-QA проверки (Phase 1 / P0-4).
--   Отчёт содержит summary (totals, errors, warnings, coverOk, verdict),
--   per-slot диагностику (формат, размеры, sha256, issues[]) и группы
--   дублей по sha256 (duplicate_groups).
--
--   Колонка nullable — если изображения не запрошены (rare) или image-QA
--   отключен через INFO_ARTICLE_IMAGE_QA_ENABLED=false, поле остаётся NULL.
--
--   Соответствует ensureSchema() в backend/server.js — этот файл нужен для
--   ручного применения вне Node.

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS image_qa_report JSONB;
