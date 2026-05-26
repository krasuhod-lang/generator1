-- Migration 050: A.E.G.I.S. SEO Brain — observations + retention/cleanup follow-up.
--
-- Phase C1: feedback loop pages → reward → dataset.
--   aegis_seo_observations хранит фактические GA4/GSC дельты по URL/неделя
--   и reward, рассчитанный seoBrain.computeSeoReward. Используется фоновым
--   джобом для backfill aegis_dspy_dataset.ga4_metrics.
--
-- Phase A3 follow-up: дропаем тяжёлые GIN-индексы по полным JSONB pages/diagnostics
--   (не используются ни одним запросом, раздували диск и replication lag).

DROP INDEX IF EXISTS idx_aegis_seo_memory_pages;
DROP INDEX IF EXISTS idx_aegis_seo_memory_diagnostics;

CREATE TABLE IF NOT EXISTS aegis_seo_observations (
    id              BIGSERIAL    PRIMARY KEY,
    site_key        TEXT         NOT NULL,
    url             TEXT         NOT NULL,
    observed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    week_start      DATE         NOT NULL,
    clicks          INTEGER,
    impressions     INTEGER,
    ctr             DOUBLE PRECISION,
    position        DOUBLE PRECISION,
    sessions        INTEGER,
    engagement_rate DOUBLE PRECISION,
    reward_overall  DOUBLE PRECISION,
    reward_components JSONB      NOT NULL DEFAULT '{}'::jsonb,
    delta           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    source          VARCHAR(32)  NOT NULL DEFAULT 'manual',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (site_key, url, week_start)
);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_observations_site_week
    ON aegis_seo_observations (site_key, week_start DESC);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_observations_url
    ON aegis_seo_observations (url, observed_at DESC);
