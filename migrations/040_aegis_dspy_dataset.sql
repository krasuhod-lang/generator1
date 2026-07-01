-- Migration 040: A.E.G.I.S. DSPy training dataset.
--
-- Каждая статья со Spq >= AEGIS_QUALITY_MIN_OVERALL (default 80) попадает
-- сюда как обучающий пример. DSPy MIPROv2 в weekly retrain'е тянет эту
-- таблицу, делает Bayesian search вокруг текущего system prompt'а и
-- сохраняет новые веса в brain_state/compiled_writer.yaml.
--
-- RL/PPO: колонка ppo_weight применяется поверх классической loss-функции
-- (см. backend/src/services/aegis/searchConsoleFeedback.js → computePpoWeights).

CREATE TABLE IF NOT EXISTS aegis_dspy_dataset (
    id              BIGSERIAL    PRIMARY KEY,
    article_ref     TEXT         NOT NULL,        -- info_article_tasks.id / link_article_tasks.id
    niche           TEXT,
    user_prompt     TEXT         NOT NULL,        -- то, что было передано writer'у
    html_output     TEXT         NOT NULL,
    quality_score   JSONB        NOT NULL,        -- слепок computeQualityScore
    spq_overall     NUMERIC(5,2) NOT NULL,
    ppo_weight      NUMERIC(6,3) NOT NULL DEFAULT 1.0,  -- 1 для обычных, 3 для CTR-победителей
    ga4_metrics     JSONB,                        -- {sessions, engagementRate, ...}
    model_used      TEXT,
    cost_usd        NUMERIC(10,4),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    used_in_retrain UUID                         -- ссылка на aegis_brain_versions.id
);

CREATE INDEX IF NOT EXISTS idx_aegis_dspy_niche_spq ON aegis_dspy_dataset (niche, spq_overall DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_dspy_created    ON aegis_dspy_dataset (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_dspy_unused     ON aegis_dspy_dataset (used_in_retrain) WHERE used_in_retrain IS NULL;
