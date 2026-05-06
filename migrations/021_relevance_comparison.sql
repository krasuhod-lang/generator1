-- Migration 021: «наш сайт vs ТОП конкурентов».
--
-- Опциональное поле our_url + результат сравнения (per-term gap, LSI%,
-- BM25, TF-IDF cosine, математические директивы для копирайтера).
-- Также — флаг exclude_aggregators (чекбокс на форме «Исключить
-- агрегаторы из ТОПа», см. backend/src/services/relevance/aggregatorDomains.js).
--
-- Все поля nullable: на старых отчётах останутся NULL, фронт показывает
-- блок сравнения только если comparison IS NOT NULL. Этой же логике
-- следует runtime-миграция в backend/server.js (для инсталляций, где
-- /docker-entrypoint-initdb.d уже отыграл и SQL-файлы не применяются).

ALTER TABLE relevance_reports
  ADD COLUMN IF NOT EXISTS our_url             TEXT,
  ADD COLUMN IF NOT EXISTS our_report          JSONB,
  ADD COLUMN IF NOT EXISTS comparison          JSONB,
  ADD COLUMN IF NOT EXISTS exclude_aggregators BOOLEAN NOT NULL DEFAULT FALSE;
