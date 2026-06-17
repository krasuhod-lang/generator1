-- Migration 077: Unified reports / position bridge / DOCX export support

ALTER TABLE position_projects
  ADD COLUMN IF NOT EXISTS parent_project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_position_projects_parent_project_unique
  ON position_projects (parent_project_id)
  WHERE parent_project_id IS NOT NULL;

ALTER TABLE report_drafts
  ADD COLUMN IF NOT EXISTS llm_quick_wins JSONB,
  ADD COLUMN IF NOT EXISTS llm_vulnerabilities JSONB,
  ADD COLUMN IF NOT EXISTS llm_roadmap JSONB,
  ADD COLUMN IF NOT EXISTS llm_traffic_value TEXT;

ALTER TABLE keys_so_cache
  ADD COLUMN IF NOT EXISTS keywords_top50 INTEGER,
  ADD COLUMN IF NOT EXISTS adcost NUMERIC(14,2);

ALTER TABLE position_results
  ADD COLUMN IF NOT EXISTS is_found BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS result_page INTEGER;
