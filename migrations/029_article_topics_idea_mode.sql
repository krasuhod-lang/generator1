-- =================================================================
-- Migration 029: Article Topics — Idea-mode (Подбор тем статей)
-- =================================================================
-- Расширяет инфраструктуру article_topic_tasks третьим режимом
-- 'topic_ideas': один Gemini-вызов, который проводит анализ рынка /
-- сущностей / интентов и предлагает ровно N тем статей + описание ЦА
-- + список фактов о бренде/нише. Все артефакты сохраняются в новых
-- JSONB-колонках, чтобы info-article / link-article могли подтянуть
-- их без повторного парсинга markdown.
--
-- Изменения additive-only и идемпотентные:
--   • новое значение enum 'topic_ideas' (через DO $$ блок, как в 015);
--   • четыре новые колонки в article_topic_tasks:
--       - topic_count_requested INT  — N, который пользователь запросил;
--       - topic_count_returned  INT  — сколько тем модель реально вернула
--                                       (может быть < N, если whitespace
--                                       мало — задачу не валим, просто
--                                       пишем warning в module_context_used);
--       - topic_ideas_json      JSONB — структурированный JSON со схемой
--                                       { market_overview, entities,
--                                         intents, audience_profile,
--                                         brand_facts, topics, coverage_map };
--       - audience_profile      JSONB — отдельная копия audience-блока
--                                       (для быстрого префилла info-article
--                                       без чтения большого topic_ideas_json);
--       - brand_facts_json      JSONB — массив verified-facts с confidence;
--                                       НЕ путать с info_article_tasks.brand_facts
--                                       (там — единая длинная строка).
-- =================================================================

DO $$
BEGIN
  -- ALTER TYPE ... ADD VALUE сам по себе идемпотентен только начиная с PG 12,
  -- но IF NOT EXISTS появилось ещё раньше; на всякий случай обернём в
  -- проверку pg_enum, чтобы миграция была безопасна и для более старых
  -- инсталляций (тот же паттерн, что в 015 для CREATE TYPE).
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
      JOIN pg_enum e ON t.oid = e.enumtypid
     WHERE t.typname = 'article_topic_mode'
       AND e.enumlabel = 'topic_ideas'
  ) THEN
    ALTER TYPE article_topic_mode ADD VALUE 'topic_ideas';
  END IF;
END$$;

ALTER TABLE article_topic_tasks
  ADD COLUMN IF NOT EXISTS topic_count_requested INT,
  ADD COLUMN IF NOT EXISTS topic_count_returned  INT,
  ADD COLUMN IF NOT EXISTS topic_ideas_json      JSONB,
  ADD COLUMN IF NOT EXISTS audience_profile      JSONB,
  ADD COLUMN IF NOT EXISTS brand_facts_json      JSONB;
