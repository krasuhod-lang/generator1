-- Migration 048: A.E.G.I.S. prompt tracking and DSPy linkage.
--
-- Храним только fingerprints/метаданные промтов, без текста промтов.
-- Это даёт аудит «когда что поменялось» и связывает качество/обучение DSPy
-- с конкретной версией Prompts-as-Code.

CREATE TABLE IF NOT EXISTS aegis_prompt_audit (
    id              BIGSERIAL    PRIMARY KEY,
    prompt_key      TEXT         NOT NULL,
    source_path     TEXT         NOT NULL,
    prompt_hash     VARCHAR(64)  NOT NULL,
    previous_hash   VARCHAR(64),
    change_kind     VARCHAR(16)  NOT NULL DEFAULT 'created', -- created|changed
    role            VARCHAR(32)  NOT NULL DEFAULT 'prompt',
    dspy_linked     BOOLEAN      NOT NULL DEFAULT FALSE,
    content_chars   INTEGER      NOT NULL DEFAULT 0,
    vars            JSONB        NOT NULL DEFAULT '[]'::jsonb,
    active          BOOLEAN      NOT NULL DEFAULT TRUE,
    first_seen_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    changed_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aegis_prompt_audit_changed
    ON aegis_prompt_audit (changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_aegis_prompt_audit_key
    ON aegis_prompt_audit (prompt_key, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_aegis_prompt_audit_hash
    ON aegis_prompt_audit (prompt_hash);

ALTER TABLE IF EXISTS aegis_dspy_dataset
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS prompt_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE IF EXISTS aegis_quality_log
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS prompt_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_aegis_dspy_prompt_hash
    ON aegis_dspy_dataset (prompt_hash)
    WHERE prompt_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_prompt_hash
    ON aegis_quality_log (prompt_hash)
    WHERE prompt_hash IS NOT NULL;
