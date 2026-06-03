-- Migration 062: расширение aegis_biobrain_versions для timeline поколений NEAT.
--
-- Изначально таблица (см. server.js ensureSchema, ранее без отдельной миграции)
-- хранила только generation/nodes/connections/mean_fitness. Эта миграция
-- добавляет поля для:
--   • hold-out validation (holdout_mae, prev_holdout_mae, rolled_back) —
--     B6: anti-regression guard в evolver.evolve_step;
--   • счётчик эволюций и параметры роста (evolve_count, buffer_size,
--     complexity_lambda) — UI «🧬 Версии мозга» рисует timeline и подсветит
--     откаты.
-- Все колонки идемпотентны (IF NOT EXISTS), безопасно прогонять много раз.

CREATE TABLE IF NOT EXISTS aegis_biobrain_versions (
    id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    generation    INTEGER      NOT NULL DEFAULT 0,
    nodes         INTEGER      NOT NULL DEFAULT 0,
    connections   INTEGER      NOT NULL DEFAULT 0,
    mean_fitness  NUMERIC(10,6),
    state_path    TEXT,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

ALTER TABLE aegis_biobrain_versions
    ADD COLUMN IF NOT EXISTS evolve_count        INTEGER,
    ADD COLUMN IF NOT EXISTS buffer_size         INTEGER,
    ADD COLUMN IF NOT EXISTS holdout_mae         NUMERIC(10,6),
    ADD COLUMN IF NOT EXISTS prev_holdout_mae    NUMERIC(10,6),
    ADD COLUMN IF NOT EXISTS complexity_lambda   NUMERIC(10,6),
    ADD COLUMN IF NOT EXISTS complexity_penalty  NUMERIC(10,6),
    ADD COLUMN IF NOT EXISTS best_fitness        NUMERIC(10,6),
    ADD COLUMN IF NOT EXISTS conns               INTEGER,
    ADD COLUMN IF NOT EXISTS rolled_back         BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS evolved_at          TIMESTAMPTZ;

-- Уникальность по (generation, evolved_at) защищает от дублей, когда
-- biobrainScheduler опрашивает /biobrain/generations на каждом тике.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_biobrain_versions_gen_at
    ON aegis_biobrain_versions (generation, evolved_at);
CREATE INDEX IF NOT EXISTS idx_aegis_biobrain_versions_created
    ON aegis_biobrain_versions (created_at DESC);
