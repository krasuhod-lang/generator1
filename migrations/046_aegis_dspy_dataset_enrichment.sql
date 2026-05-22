-- Migration 046: A.E.G.I.S. DSPy dataset enrichment and dedup.

ALTER TABLE IF EXISTS aegis_dspy_dataset
  ADD COLUMN IF NOT EXISTS user_hash TEXT,
  ADD COLUMN IF NOT EXISTS source_kind TEXT;

DELETE FROM aegis_dspy_dataset d
USING aegis_dspy_dataset d2
WHERE d.article_ref = d2.article_ref
  AND d.id < d2.id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_dspy_article_ref
  ON aegis_dspy_dataset (article_ref);
