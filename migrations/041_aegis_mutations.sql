-- Migration 041: A.E.G.I.S. self-mutations (предложения DeepSeek-программиста).
--
-- Каждый вызов /api/aegis/mutate/propose логируется сюда. Хранятся как
-- успешные diff'ы (применённые/отклонённые), так и abort'ы.
-- PR создаётся отдельным workflow и пишет pr_url по факту мерджа.

CREATE TABLE IF NOT EXISTS aegis_mutations (
    id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    file_path       TEXT         NOT NULL,
    trigger_reason  TEXT,                          -- "scraper.example.com 5 failures in a row"
    abort           BOOLEAN      NOT NULL DEFAULT false,
    abort_reason    TEXT,                          -- low_confidence | out_of_scope | ...
    diff_text       TEXT,                          -- unified-diff (null если abort)
    pr_number       INTEGER,                       -- GitHub PR № когда применили
    pr_url          TEXT,
    pr_status       VARCHAR(16),                   -- draft|open|merged|closed
    tokens_cost_usd NUMERIC(10,4),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    merged_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_aegis_mut_created ON aegis_mutations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_mut_pr      ON aegis_mutations (pr_number) WHERE pr_number IS NOT NULL;
