-- Migration 044: A.E.G.I.S. Phase 14 — DSPy seed dataset, ε-greedy runs,
-- vector-DB garbage-collection log.
--
-- 1. aegis_dspy_dataset.is_seed — помечает синтетические эталонные строки,
--    которыми мы «холодно стартуем» MIPROv2, когда реальной истории ещё нет.
-- 2. aegis_dspy_runs — журнал каждого MIPROv2 retrain (или его dry-run),
--    с пометкой mutation_applied (ε-greedy выстрел).
-- 3. aegis_vector_gc_log — что именно мы зачистили в Qdrant ночным GC
--    или per-run cleanup'ом (для аудита/прометея).

-- ── 1. is_seed на dataset ────────────────────────────────────────────
ALTER TABLE aegis_dspy_dataset
    ADD COLUMN IF NOT EXISTS is_seed BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_aegis_dspy_seed
    ON aegis_dspy_dataset (is_seed) WHERE is_seed = TRUE;

-- ── 2. журнал retrain'ов ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS aegis_dspy_runs (
    id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    niche              TEXT,
    dry_run            BOOLEAN      NOT NULL DEFAULT FALSE,
    rows_real          INTEGER      NOT NULL DEFAULT 0,
    rows_seed          INTEGER      NOT NULL DEFAULT 0,
    max_trials         INTEGER      NOT NULL DEFAULT 0,
    improvement_pct    NUMERIC(6,3),
    mutation_applied   BOOLEAN      NOT NULL DEFAULT FALSE,
    epsilon_rate       NUMERIC(5,4),
    status             VARCHAR(32)  NOT NULL DEFAULT 'planned',
    -- planned | seed_only | trained | deployed | skipped_no_data | error
    cost_usd           NUMERIC(10,4) NOT NULL DEFAULT 0,
    notes              JSONB,
    started_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_aegis_dspy_runs_started
    ON aegis_dspy_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_dspy_runs_status
    ON aegis_dspy_runs (status);

-- ── 3. лог GC векторной памяти ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS aegis_vector_gc_log (
    id              BIGSERIAL    PRIMARY KEY,
    kind            VARCHAR(16)  NOT NULL,   -- 'sweep' | 'per_run' | 'manual'
    collection      TEXT,
    run_id          UUID,                    -- ссылка на aegis_runs.id, если per_run
    older_than_days INTEGER,
    points_deleted  INTEGER      NOT NULL DEFAULT 0,
    collections_seen INTEGER     NOT NULL DEFAULT 0,
    status          VARCHAR(16)  NOT NULL DEFAULT 'ok',  -- ok|skipped|error
    reason          TEXT,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aegis_vector_gc_log_created
    ON aegis_vector_gc_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_vector_gc_log_run
    ON aegis_vector_gc_log (run_id) WHERE run_id IS NOT NULL;
