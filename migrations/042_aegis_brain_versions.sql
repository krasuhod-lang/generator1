-- Migration 042: A.E.G.I.S. brain versions (история DSPy-компиляций).
--
-- Каждый успешный DSPy retrain создаёт запись здесь:
--   • yaml_path: путь до compiled_writer.yaml относительно репозитория
--   • sha:      git-коммит, в котором выкатили новую версию (для отката)
--   • mean_spq_before/after: метрика улучшения (cf. AEGIS_DSPY_MIN_IMPROVEMENT_PCT)
--
-- UI /aegis/brain/versions показывает эту таблицу как timeline эволюции.

CREATE TABLE IF NOT EXISTS aegis_brain_versions (
    id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    yaml_path         TEXT         NOT NULL,
    sha               VARCHAR(40),
    mean_spq_before   NUMERIC(5,2),
    mean_spq_after    NUMERIC(5,2),
    improvement_pct   NUMERIC(6,3),
    trials_done       INTEGER,
    dataset_size      INTEGER,
    cost_usd          NUMERIC(10,4),
    deployed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    rolled_back_at    TIMESTAMPTZ,                -- если потом вернулись на старую версию
    notes             TEXT
);

CREATE INDEX IF NOT EXISTS idx_aegis_brain_deployed ON aegis_brain_versions (deployed_at DESC);
