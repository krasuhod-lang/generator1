-- Migration 033: расширяем forecaster_tasks для URL продвигаемого сайта
-- и AI-разметки шлак-запросов.
--
-- target_url   — URL сайта, который продвигаем (опционально). Передаётся
--                DeepSeek-у для контекста рекомендаций и используется в
--                junk-классификаторе для отсева чужих брендов/доменов.
-- junk_phrases — JSON с детерминированной разметкой шлак-запросов
--                (reasons, severity) + опциональным DeepSeek-обогащением
--                (ai_verdict, ai_reason).

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS target_url   TEXT,
  ADD COLUMN IF NOT EXISTS junk_phrases JSONB;
