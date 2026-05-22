-- Migration 039: A.E.G.I.S. backlog (GitHub Issues автопилота).
--
-- Forecaster (Модуль 5, Opportunity Hunter) находит "White Space" и
-- создаёт issue с label aegis:ready. Свободный Ray-worker берёт его
-- в работу. Здесь — локальное зеркало для UI без обращения к GH API
-- на каждый рендер.

CREATE TABLE IF NOT EXISTS aegis_backlog (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_number    INTEGER      NOT NULL UNIQUE,    -- GitHub issue №
    title           TEXT         NOT NULL,
    labels          JSONB        NOT NULL DEFAULT '[]'::jsonb,
    niche           TEXT,
    lsi_cluster_id  TEXT,
    status          VARCHAR(16)  NOT NULL DEFAULT 'pending',
                                                     -- pending|in_progress|done|failed|skipped
    picked_by       TEXT,                            -- worker_id (для отслеживания)
    picked_at       TIMESTAMPTZ,
    aegis_run_id    UUID,                            -- ссылка на aegis_runs
    notes           TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aegis_backlog_status  ON aegis_backlog (status);
CREATE INDEX IF NOT EXISTS idx_aegis_backlog_created ON aegis_backlog (created_at DESC);
