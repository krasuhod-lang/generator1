-- Migration 072:
--   Голос аудитории (Reddit Mapper V2 → IAKB §10) для генератора инфо-статьи.
--   В колонке audience_research хранится наблюдаемая A/B-телеметрия слоя
--   §10 (бакет test/control, признак наличия сигнала, число сигналов,
--   пройденные этапы, причина пропуска). Используется для офлайн-сравнения
--   качества статей с §10 и без него (Information Gain / уникальность /
--   покрытие болей аудитории).
--
--   Дублируется в backend/server.js ensureSchema() для авто-применения при
--   старте Node-процесса. Этот файл — для ручного применения вне Node.

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS audience_research JSONB;
