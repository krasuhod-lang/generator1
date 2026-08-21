-- Migration 134: A.E.G.I.S. self-learning feedback and versioned artifacts.
-- Idempotent: safe for existing production volumes.

ALTER TABLE aegis_serp_outcomes
  ADD COLUMN IF NOT EXISTS outcome_key TEXT,
  ADD COLUMN IF NOT EXISTS measure_after_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS measurement_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS task_id TEXT,
  ADD COLUMN IF NOT EXISTS opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT,
  ADD COLUMN IF NOT EXISTS baseline_metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS post_metrics JSONB,
  ADD COLUMN IF NOT EXISTS sample_size INTEGER,
  ADD COLUMN IF NOT EXISTS measured_source TEXT,
  ADD COLUMN IF NOT EXISTS feedback_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS feedback_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS feedback_last_error TEXT;

UPDATE aegis_serp_outcomes
   SET outcome_key = md5(COALESCE(url, '') || '|' || published_at::text || '|' || id::text)
 WHERE outcome_key IS NULL;

UPDATE aegis_serp_outcomes
   SET measure_after_at = published_at + INTERVAL '14 days'
 WHERE measure_after_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_serp_outcomes_outcome_key
  ON aegis_serp_outcomes (outcome_key)
  WHERE outcome_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_due
  ON aegis_serp_outcomes(status, measure_after_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_feedback_due
  ON aegis_serp_outcomes(status, feedback_next_attempt_at)
  WHERE status = 'measured';

ALTER TABLE aegis_brain_versions
  ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'deployed',
  ADD COLUMN IF NOT EXISTS artifact_sha VARCHAR(64),
  ADD COLUMN IF NOT EXISTS artifact_type VARCHAR(40) NOT NULL DEFAULT 'dspy_compiled',
  ADD COLUMN IF NOT EXISTS holdout_score NUMERIC(7,3),
  ADD COLUMN IF NOT EXISTS evaluation JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS deployed_by VARCHAR(80);
CREATE INDEX IF NOT EXISTS idx_aegis_brain_versions_status
  ON aegis_brain_versions (status, deployed_at DESC);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS published_url TEXT,
  ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT,
  ADD COLUMN IF NOT EXISTS opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID,
  ADD COLUMN IF NOT EXISTS success_metric JSONB;
CREATE INDEX IF NOT EXISTS idx_tasks_published_url
  ON tasks (published_url) WHERE published_url IS NOT NULL;

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS published_url TEXT,
  ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS published_url TEXT,
  ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE meta_tag_tasks
  ADD COLUMN IF NOT EXISTS published_url TEXT,
  ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS prompt_version TEXT,
  ADD COLUMN IF NOT EXISTS model_version TEXT;

CREATE INDEX IF NOT EXISTS idx_info_article_tasks_published_url
  ON info_article_tasks (published_url) WHERE published_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_link_article_tasks_published_url
  ON link_article_tasks (published_url) WHERE published_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_published_url
  ON meta_tag_tasks (published_url) WHERE published_url IS NOT NULL;

ALTER TABLE aegis_experiments
  ADD COLUMN IF NOT EXISTS project_id UUID,
  ADD COLUMN IF NOT EXISTS opportunity_id UUID,
  ADD COLUMN IF NOT EXISTS task_id TEXT,
  ADD COLUMN IF NOT EXISTS measure_after_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS measurement_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_error TEXT,
  ADD COLUMN IF NOT EXISTS feedback_status VARCHAR(16) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS feedback_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS feedback_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS feedback_last_error TEXT;
CREATE INDEX IF NOT EXISTS idx_aegis_experiments_due
  ON aegis_experiments(status, measure_after_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_aegis_experiments_feedback_due
  ON aegis_experiments(status, feedback_status, feedback_next_attempt_at);
