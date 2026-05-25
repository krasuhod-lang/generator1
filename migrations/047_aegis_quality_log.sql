-- Migration 047: A.E.G.I.S. quality log — «теневой» датасет.
--
-- В отличие от aegis_dspy_dataset (узкая золотая выборка для DSPy с гейтом
-- SPQ ≥ 80), сюда пишется КАЖДАЯ завершённая генерация — независимо от того,
-- прошла она гейт качества или нет.
--
-- Цель — Root Cause Analysis: вместо того чтобы молча отбрасывать «провальные»
-- статьи, мы фиксируем все субметрики и список симптомов (`failure_reasons`,
-- `top_failure_layer`, `diagnoses`), чтобы видеть «почему статья получила 7.1 по
-- E-E-A-T, что её утопило». Это «universe of truth» для аналитики/уроков.
--
-- DSPy compiled_writer.yaml ОБУЧАЕТСЯ ПО-ПРЕЖНЕМУ только на aegis_dspy_dataset.
-- Эта таблица — наблюдение, а не обучение (см. план в issue/PR).

CREATE TABLE IF NOT EXISTS aegis_quality_log (
    id                  BIGSERIAL    PRIMARY KEY,
    article_ref         TEXT         NOT NULL,
    kind                VARCHAR(32)  NOT NULL,
    niche               TEXT,

    -- Сводный SPQ (0..100) — может быть NULL, если qualityScore вернул null.
    spq_overall         NUMERIC(5,2),
    -- Полный qualityScore.subscores (eeat, fact_check, plagiarism, intent,
    -- lsi, readability, image_qa, validation).
    sub                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Сжатая сводка verdict'ов: { eeat:'pass', fact_check:'review', ... }.
    verdict_summary     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    -- Список симптомов из failureAnalyzer: ['unsupported_numbers', ...]
    failure_reasons     JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Один слой/субметрика, давшая наибольший пробой («лидер падения»).
    top_failure_layer   TEXT,
    -- Полный отчёт failureAnalyzer (symptoms[] с деталями).
    diagnoses           JSONB        NOT NULL DEFAULT '{}'::jsonb,

    -- Финальный статус (зеркалит aegis_runs.status).
    -- success | rejected_by_gate | needs_refine | failed
    status              VARCHAR(24)  NOT NULL DEFAULT 'success',
    -- true, если запись прошла «золотой» гейт (SPQ ≥ minOverall + minSub).
    passes_gate         BOOLEAN      NOT NULL DEFAULT false,

    model_used          TEXT,
    cost_usd            NUMERIC(10,4),
    iterations          INTEGER      NOT NULL DEFAULT 0,
    user_hash           TEXT,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_quality_log_article_ref
    ON aegis_quality_log (article_ref);

CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_created
    ON aegis_quality_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_kind
    ON aegis_quality_log (kind);

CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_niche
    ON aegis_quality_log (niche);

CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_top_layer
    ON aegis_quality_log (top_failure_layer)
    WHERE top_failure_layer IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_spq
    ON aegis_quality_log (spq_overall)
    WHERE spq_overall IS NOT NULL;

-- GIN на failure_reasons — для агрегата «топ причин за N дней».
CREATE INDEX IF NOT EXISTS idx_aegis_quality_log_reasons
    ON aegis_quality_log USING GIN (failure_reasons);
