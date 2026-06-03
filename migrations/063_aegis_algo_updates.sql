-- Migration 063: A.E.G.I.S. AlgoWatcher — лента обновлений поисковых
-- алгоритмов (Google Search Central blog, Search Engine Roundtable, и т.п.).
--
-- Сервис backend/src/services/aegis/algoWatcher.js раз в час тянет RSS,
-- складывает уникальные элементы (по url+source), а LLM-классификатор
-- (опционально) расставляет теги/severity. UI «📜 История обновлений
-- мозга» подмешивает эту таблицу в timeline.

CREATE TABLE IF NOT EXISTS aegis_algo_updates (
    id            BIGSERIAL    PRIMARY KEY,
    source        TEXT         NOT NULL,    -- 'google_search_central' / 'serp_roundtable' / ...
    title         TEXT         NOT NULL,
    url           TEXT         NOT NULL,
    summary       TEXT,
    published_at  TIMESTAMPTZ,
    fetched_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Tags выставляет LLM-классификатор: core_update, spam_update,
    -- helpful_content, eeat, linking, technical, ranking_factor, ...
    tags          TEXT[]       NOT NULL DEFAULT '{}',
    severity      NUMERIC(4,3),             -- 0..1, оценка LLM
    classified_at TIMESTAMPTZ,
    raw           JSONB        NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_algo_updates_src_url
    ON aegis_algo_updates (source, url);
CREATE INDEX IF NOT EXISTS idx_aegis_algo_updates_published
    ON aegis_algo_updates (published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_aegis_algo_updates_tags
    ON aegis_algo_updates USING GIN (tags);
