-- Migration 051: article_topics_brand_history.
--
-- Зачем: при повторной генерации тем под тот же бренд (brand_hint) хочется
-- не плодить дубли, а в новом наборе пометить «🔁 уже было в задаче X».
--
-- Хранит канонизированные заголовки/H1 по нормализованному brand_key (см.
-- backend/src/services/articleTopics/brandKey.js: lower+translit+collapse).
-- topic_idea_task_id — FK на article_topic_tasks.id, чтобы UI мог дать
-- ссылку на оригинальную задачу.
--
-- Используется topicDuplicateDetector (трёхступенчатый prefilter +
-- DeepSeek-арбитр для 0.55–0.85), результат записывается в
-- topic_ideas_json.topics[i].duplicate_of.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS article_topics_brand_history (
    id                     BIGSERIAL    PRIMARY KEY,
    user_id                UUID         NOT NULL,
    brand_key              TEXT         NOT NULL,
    topic_title_canon      TEXT         NOT NULL,
    topic_h1_canon         TEXT,
    primary_intent         TEXT,
    intent_facet           TEXT,
    topic_idea_task_id     UUID         REFERENCES article_topic_tasks(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, brand_key, topic_title_canon)
);

CREATE INDEX IF NOT EXISTS idx_article_topics_brand_history_userbrand
    ON article_topics_brand_history (user_id, brand_key);

CREATE INDEX IF NOT EXISTS idx_article_topics_brand_history_title_trgm
    ON article_topics_brand_history USING GIN (topic_title_canon gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_article_topics_brand_history_created
    ON article_topics_brand_history (created_at DESC);
