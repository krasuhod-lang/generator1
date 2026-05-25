-- Migration 049: A.E.G.I.S. SEO Brain.
--
-- Хранит SEO-память сайта и безопасный action-plan автономного SEO-агента:
-- страницы/кластеры/интенты/GSC/GA4/keys.so/SPQ сигналы, reward,
-- диагностику и предложенные действия.

CREATE TABLE IF NOT EXISTS aegis_seo_memory (
    site_key        TEXT         PRIMARY KEY,
    site_url        TEXT,
    pages           JSONB        NOT NULL DEFAULT '[]'::jsonb,
    clusters        JSONB        NOT NULL DEFAULT '{}'::jsonb,
    signals         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    reward          JSONB        NOT NULL DEFAULT '{}'::jsonb,
    diagnostics     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    action_plan     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    autonomy_stage  VARCHAR(32)  NOT NULL DEFAULT 'recommend',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_memory_updated
    ON aegis_seo_memory (updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_memory_pages
    ON aegis_seo_memory USING GIN (pages);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_memory_diagnostics
    ON aegis_seo_memory USING GIN (diagnostics);

CREATE TABLE IF NOT EXISTS aegis_seo_actions (
    id            BIGSERIAL    PRIMARY KEY,
    site_key      TEXT         NOT NULL REFERENCES aegis_seo_memory(site_key) ON DELETE CASCADE,
    action_key    TEXT         NOT NULL,
    action_type   VARCHAR(64)  NOT NULL,
    target_url    TEXT,
    cluster       TEXT,
    intent        TEXT,
    priority      INTEGER      NOT NULL DEFAULT 0,
    status        VARCHAR(32)  NOT NULL DEFAULT 'recommended',
    payload       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (site_key, action_key)
);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_actions_site_priority
    ON aegis_seo_actions (site_key, priority DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_actions_status
    ON aegis_seo_actions (status);

CREATE INDEX IF NOT EXISTS idx_aegis_seo_actions_type
    ON aegis_seo_actions (action_type);
