-- Migration 038: A.E.G.I.S. runs (трассировка LangGraph-циклов).
--
-- Каждый запуск orchestrator.runRefineLoop пишет сюда финальный результат:
-- сколько итераций, какой overall score, сколько потрачено, какой verdict.
-- Используется фронтом /aegis для дашборда и аналитики «mean Spq по времени».

CREATE TABLE IF NOT EXISTS aegis_runs (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            VARCHAR(32)  NOT NULL DEFAULT 'super_core_seo',
    task_ref        TEXT,                    -- ссылка на info_article/link_article task id
    niche           TEXT,
    status          VARCHAR(16)  NOT NULL DEFAULT 'pending',  -- pending|running|passed|review|failed
    overall_score   NUMERIC(5,2),            -- 0..100
    iterations      INTEGER      NOT NULL DEFAULT 0,
    cost_usd        NUMERIC(10,4) NOT NULL DEFAULT 0,
    tokens_in       BIGINT       NOT NULL DEFAULT 0,
    tokens_out      BIGINT       NOT NULL DEFAULT 0,
    audit           JSONB,                   -- evaluateQualityGate финального
    trace           JSONB,                   -- массив iter->{overall, verdict, reason}
    error_message   TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_aegis_runs_created    ON aegis_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_runs_status     ON aegis_runs (status);
CREATE INDEX IF NOT EXISTS idx_aegis_runs_overall    ON aegis_runs (overall_score) WHERE overall_score IS NOT NULL;
