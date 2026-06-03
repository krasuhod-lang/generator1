-- Migration 064: A.E.G.I.S. SERP outcomes — замыкаем петлю обучения
-- Bio-Brain на реальный результат в выдаче Google.
--
-- При публикации статьи aegisBridge.recordSerpFeedback() сохраняет здесь
-- {url, queries, features черновика}. Через 7/14/28 дней
-- serpOutcomeTracker.closeOutcome() читает позиции по этим запросам из
-- GSC (gscService) или xmlstockClient.fetchGoogleSerp, считает
-- взвешенный reward (Δposition + Δclicks PoP + Top-3/Top-10 hit) и
-- вызывает biobrainClient.feedback({ real_spq_overall: reward }) — теперь
-- мозг учится не «себя на себя», а связке «свойства черновика → позиция».

CREATE TABLE IF NOT EXISTS aegis_serp_outcomes (
    id              BIGSERIAL    PRIMARY KEY,
    url             TEXT         NOT NULL,
    queries         TEXT[]       NOT NULL DEFAULT '{}',
    features        REAL[]       NOT NULL DEFAULT '{}',  -- 8D вектор биомозга
    feature_labels  TEXT[]       NOT NULL DEFAULT '{}',  -- параллельный массив имён
    -- Bookkeeping для замыкания петли:
    published_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    measured_at     TIMESTAMPTZ,
    -- Метрики реального успеха в SERP (заполняются через N дней):
    avg_position    NUMERIC(7,3),
    best_position   NUMERIC(7,3),
    in_top3         INTEGER      NOT NULL DEFAULT 0,
    in_top10        INTEGER      NOT NULL DEFAULT 0,
    delta_clicks    NUMERIC(12,2),
    delta_ctr       NUMERIC(6,4),
    reward          NUMERIC(6,4),    -- 0..1, итоговый сигнал в biobrain.feedback
    -- Состояние замыкания петли:
    status          VARCHAR(20)  NOT NULL DEFAULT 'pending', -- pending|measured|fed
    project_id      UUID,                                    -- ссылка на projects (опц.)
    notes           TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_serp_outcomes_url_pub
    ON aegis_serp_outcomes (url, published_at);
CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_status
    ON aegis_serp_outcomes (status, published_at);
CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_published
    ON aegis_serp_outcomes (published_at DESC);
