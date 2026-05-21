-- Migration 043: A.E.G.I.S. Phase 9–13 — observability/FinOps/backups.
--
-- Три новые таблицы:
--   aegis_killswitch — журнал переключений глобального стоп-флага.
--   aegis_alerts     — журнал отправленных алертов (Telegram/Slack/log).
--   aegis_backups    — журнал запусков снапшотов Qdrant/Neo4j.

CREATE TABLE IF NOT EXISTS aegis_killswitch (
    id          BIGSERIAL    PRIMARY KEY,
    engaged     BOOLEAN      NOT NULL,
    reason      TEXT,
    set_by      TEXT,
    set_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aegis_kill_set_at ON aegis_killswitch (set_at DESC);

CREATE TABLE IF NOT EXISTS aegis_alerts (
    id          BIGSERIAL    PRIMARY KEY,
    severity    VARCHAR(16)  NOT NULL,           -- info|warning|critical
    message     TEXT         NOT NULL,
    payload     JSONB,
    deliveries  JSONB        NOT NULL DEFAULT '[]'::jsonb,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aegis_alerts_created ON aegis_alerts (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_alerts_severity ON aegis_alerts (severity);

CREATE TABLE IF NOT EXISTS aegis_backups (
    id          BIGSERIAL    PRIMARY KEY,
    status      VARCHAR(16)  NOT NULL,
    targets     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    result      JSONB,
    s3_bucket   TEXT,
    bytes_total BIGINT,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_aegis_backups_created ON aegis_backups (created_at DESC);
