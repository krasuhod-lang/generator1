-- Unified Projects -> Analysis -> Growth Opportunities -> Reports pipeline.
-- Idempotent migration; runtime bootstrap mirrors these statements for old volumes.

ALTER TABLE project_analyses
  ADD COLUMN IF NOT EXISTS job_id TEXT,
  ADD COLUMN IF NOT EXISTS worker_id TEXT,
  ADD COLUMN IF NOT EXISTS lease_token UUID,
  ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_project_analyses_durable_queue
  ON project_analyses(status, lease_until, created_at)
  WHERE status IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_analyses_job_id
  ON project_analyses(job_id)
  WHERE job_id IS NOT NULL;

ALTER TABLE report_drafts
  ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS report_model_version VARCHAR(64) NOT NULL DEFAULT 'reports-v2',
  ADD COLUMN IF NOT EXISTS client_insights JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS selected_opportunity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS data_quality JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS llm_worker_id TEXT,
  ADD COLUMN IF NOT EXISTS llm_lease_token UUID,
  ADD COLUMN IF NOT EXISTS llm_lease_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS llm_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS llm_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_recovery_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS llm_last_error_code TEXT;

CREATE INDEX IF NOT EXISTS idx_report_drafts_analysis
  ON report_drafts(analysis_id)
  WHERE analysis_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_report_drafts_llm_recovery
  ON report_drafts(llm_status, llm_lease_until)
  WHERE llm_status IN ('queued', 'running');

ALTER TABLE shared_reports
  ADD COLUMN IF NOT EXISTS view_mode VARCHAR(16) NOT NULL DEFAULT 'client',
  ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS report_model_version VARCHAR(64) NOT NULL DEFAULT 'reports-v2';

CREATE TABLE IF NOT EXISTS project_growth_opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL,
  snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL,
  opportunity_key TEXT NOT NULL,
  category VARCHAR(40) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'open',
  priority VARCHAR(16) NOT NULL DEFAULT 'medium',
  priority_score NUMERIC(8,3),
  title TEXT NOT NULL,
  target JSONB NOT NULL DEFAULT '{}'::jsonb,
  current_metric JSONB NOT NULL DEFAULT '{}'::jsonb,
  target_metric JSONB NOT NULL DEFAULT '{}'::jsonb,
  measurement JSONB NOT NULL DEFAULT '{}'::jsonb,
  impact JSONB NOT NULL DEFAULT '{}'::jsonb,
  effort VARCHAR(16),
  confidence NUMERIC(5,4),
  observed_fact TEXT,
  hypothesis TEXT,
  recommendation TEXT NOT NULL,
  success_metric TEXT,
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_task_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  measured_at TIMESTAMPTZ,
  next_check_at DATE,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, opportunity_key)
);

ALTER TABLE project_growth_opportunities
  ADD COLUMN IF NOT EXISTS measurement JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS next_check_at DATE;

CREATE INDEX IF NOT EXISTS idx_growth_opp_project_status
  ON project_growth_opportunities(project_id, status, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_growth_opp_analysis
  ON project_growth_opportunities(analysis_id);
CREATE INDEX IF NOT EXISTS idx_growth_opp_snapshot
  ON project_growth_opportunities(snapshot_id);

ALTER TABLE tasks_auto_log
  ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS success_metric TEXT,
  ADD COLUMN IF NOT EXISTS after_check_due_at DATE;

CREATE INDEX IF NOT EXISTS idx_tasks_auto_log_opportunity
  ON tasks_auto_log(opportunity_id)
  WHERE opportunity_id IS NOT NULL;

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL;
ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL;
ALTER TABLE meta_tag_tasks
  ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_info_article_tasks_opportunity ON info_article_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_link_article_tasks_opportunity ON link_article_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_opportunity ON meta_tag_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL;
