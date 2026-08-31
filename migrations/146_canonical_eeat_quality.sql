-- 146: Canonical E-E-A-T/PQ quality contract.
-- Additive only: legacy eeat_score/pq_score and historical reports remain intact.
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS eeat_score_12 NUMERIC(4,2);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS eeat_score_12_status VARCHAR(32);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS eeat_score_12_coverage NUMERIC(5,4);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS eeat_score_12_version VARCHAR(64);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS eeat_score_12_components JSONB;
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS content_quality_score NUMERIC(5,2);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS content_quality_status VARCHAR(32);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS content_quality_coverage NUMERIC(5,4);
ALTER TABLE task_metrics ADD COLUMN IF NOT EXISTS quality_score_version VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_task_metrics_eeat12_status
  ON task_metrics (eeat_score_12_status);
CREATE INDEX IF NOT EXISTS idx_task_metrics_quality_score_version
  ON task_metrics (quality_score_version);
