'use strict';

const dbDefault = require('../../config/db');

/**
 * Runtime-safe mirror of the durable execution migrations 130–132.
 * Docker init scripts only run for a fresh PostgreSQL volume, therefore the
 * running application must apply these idempotent statements on old volumes.
 */
async function ensureDurableTaskSchema(db = dbDefault) {
  const statements = [
    `CREATE EXTENSION IF NOT EXISTS pgcrypto`,
    `ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'pausing'`,
    `ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'paused'`,
    `ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'cancelled'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checkpoint_version INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_reliability_recovery ON tasks(status, lease_until) WHERE status IN ('queued','processing')`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_generation_profile_active ON tasks(user_id, status, lease_until) WHERE status IN ('queued','processing')`,

    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS options JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS input_urls JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ`,
    `ALTER TABLE parser_tasks ADD COLUMN IF NOT EXISTS dispatch_job_id TEXT`,

    `CREATE TABLE IF NOT EXISTS parser_task_items (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      task_id UUID NOT NULL REFERENCES parser_tasks(id) ON DELETE CASCADE,
      input_url TEXT NOT NULL,
      normalized_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempts INTEGER NOT NULL DEFAULT 0,
      worker_id TEXT,
      lease_token UUID,
      lease_until TIMESTAMPTZ,
      heartbeat_at TIMESTAMPTZ,
      next_attempt_at TIMESTAMPTZ,
      checkpoint JSONB,
      result JSONB,
      error_code TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      finished_at TIMESTAMPTZ,
      UNIQUE (task_id, normalized_url)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_parser_task_items_queue ON parser_task_items(status, next_attempt_at, lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_parser_task_items_task_status ON parser_task_items(task_id, status)`,

    `CREATE TABLE IF NOT EXISTS generator_task_outbox (
      id BIGSERIAL PRIMARY KEY,
      queue_name TEXT NOT NULL,
      job_name TEXT NOT NULL,
      job_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      published_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (queue_name, job_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_generator_task_outbox_pending ON generator_task_outbox(available_at, id) WHERE published_at IS NULL`,

    `CREATE TABLE IF NOT EXISTS user_task_slot_leases (
      slot_token UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      task_type TEXT NOT NULL,
      task_id TEXT NOT NULL,
      lease_until TIMESTAMPTZ NOT NULL,
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (user_id, task_type, task_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_user_task_slot_leases_active ON user_task_slot_leases(user_id, lease_until)`,
    `CREATE INDEX IF NOT EXISTS idx_user_task_slot_leases_expiry ON user_task_slot_leases(lease_until)`,

    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE site_crawl_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `CREATE INDEX IF NOT EXISTS idx_site_crawl_tasks_recovery ON site_crawl_tasks(status, lease_until) WHERE status IN ('queued','running')`,

    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS python_task_id TEXT`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS checkpoint JSONB`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE audit_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `UPDATE audit_tasks SET python_task_id=id::text WHERE python_task_id IS NULL`,
    `CREATE INDEX IF NOT EXISTS idx_audit_tasks_recovery ON audit_tasks(status, lease_until) WHERE status IN ('pending','running')`,

    // Unified Projects -> Reports durable jobs and growth opportunities.
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS job_id TEXT`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS worker_id TEXT`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS lease_token UUID`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS lease_until TIMESTAMPTZ`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS last_error_code TEXT`,
    `ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`,
    `CREATE INDEX IF NOT EXISTS idx_project_analyses_durable_queue ON project_analyses(status, lease_until, created_at) WHERE status IN ('queued','running')`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_analyses_job_id ON project_analyses(job_id) WHERE job_id IS NOT NULL`,

    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS report_model_version VARCHAR(64) NOT NULL DEFAULT 'reports-v2'`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS client_insights JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS selected_opportunity_ids JSONB NOT NULL DEFAULT '[]'::jsonb`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS data_quality JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_worker_id TEXT`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_lease_token UUID`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_lease_until TIMESTAMPTZ`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_heartbeat_at TIMESTAMPTZ`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_recovery_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE report_drafts ADD COLUMN IF NOT EXISTS llm_last_error_code TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_report_drafts_analysis ON report_drafts(analysis_id) WHERE analysis_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_report_drafts_llm_recovery ON report_drafts(llm_status, llm_lease_until) WHERE llm_status IN ('queued','running')`,

    `ALTER TABLE shared_reports ADD COLUMN IF NOT EXISTS view_mode VARCHAR(16) NOT NULL DEFAULT 'client'`,
    `ALTER TABLE shared_reports ADD COLUMN IF NOT EXISTS snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`,
    `ALTER TABLE shared_reports ADD COLUMN IF NOT EXISTS report_model_version VARCHAR(64) NOT NULL DEFAULT 'reports-v2'`,
    `DO $$
    DECLARE existing_fk TEXT;
    BEGIN
      SELECT conname INTO existing_fk FROM pg_constraint
       WHERE conrelid = 'shared_reports'::regclass
         AND confrelid = 'report_drafts'::regclass
         AND contype = 'f' LIMIT 1;
      IF existing_fk IS NOT NULL AND existing_fk <> 'fk_shared_reports_draft_preserve' THEN
        EXECUTE format('ALTER TABLE shared_reports DROP CONSTRAINT %I', existing_fk);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_shared_reports_draft_preserve' AND conrelid = 'shared_reports'::regclass) THEN
        ALTER TABLE shared_reports ADD CONSTRAINT fk_shared_reports_draft_preserve
          FOREIGN KEY (draft_id) REFERENCES report_drafts(id) ON DELETE RESTRICT;
      END IF;
    END $$`,
    `DO $$
    DECLARE existing_fk TEXT;
    BEGIN
      SELECT conname INTO existing_fk FROM pg_constraint
       WHERE conrelid = 'shared_reports'::regclass
         AND confrelid = 'users'::regclass
         AND contype = 'f' LIMIT 1;
      IF existing_fk IS NOT NULL AND existing_fk <> 'fk_shared_reports_user_preserve' THEN
        EXECUTE format('ALTER TABLE shared_reports DROP CONSTRAINT %I', existing_fk);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_shared_reports_user_preserve' AND conrelid = 'shared_reports'::regclass) THEN
        ALTER TABLE shared_reports ADD CONSTRAINT fk_shared_reports_user_preserve
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
      END IF;
    END $$`,

    `CREATE TABLE IF NOT EXISTS project_growth_opportunities (
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
    )`,
    `ALTER TABLE project_growth_opportunities ADD COLUMN IF NOT EXISTS measurement JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE project_growth_opportunities ADD COLUMN IF NOT EXISTS next_check_at DATE`,
    `CREATE INDEX IF NOT EXISTS idx_growth_opp_project_status ON project_growth_opportunities(project_id, status, priority_score DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_growth_opp_analysis ON project_growth_opportunities(analysis_id)`,
    `CREATE INDEX IF NOT EXISTS idx_growth_opp_snapshot ON project_growth_opportunities(snapshot_id)`,
    `ALTER TABLE tasks_auto_log ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL`,
    `ALTER TABLE tasks_auto_log ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL`,
    `ALTER TABLE tasks_auto_log ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`,
    `ALTER TABLE tasks_auto_log ADD COLUMN IF NOT EXISTS success_metric TEXT`,
    `ALTER TABLE tasks_auto_log ADD COLUMN IF NOT EXISTS after_check_due_at DATE`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_auto_log_opportunity ON tasks_auto_log(opportunity_id) WHERE opportunity_id IS NOT NULL`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS opportunity_id UUID REFERENCES project_growth_opportunities(id) ON DELETE SET NULL`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS analysis_id UUID REFERENCES project_analyses(id) ON DELETE SET NULL`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS source_snapshot_id UUID REFERENCES project_snapshots(id) ON DELETE SET NULL`,
    `CREATE INDEX IF NOT EXISTS idx_info_article_tasks_opportunity ON info_article_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_link_article_tasks_opportunity ON link_article_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_opportunity ON meta_tag_tasks(opportunity_id) WHERE opportunity_id IS NOT NULL`,

    // Aegis self-learning feedback and versioned artifacts (migration 134).
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS outcome_key TEXT`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS measure_after_at TIMESTAMPTZ`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS measurement_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS last_error TEXT`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS task_id TEXT`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS opportunity_id UUID`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS model_version TEXT`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS baseline_metrics JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS post_metrics JSONB`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS sample_size INTEGER`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS measured_source TEXT`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS feedback_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS feedback_next_attempt_at TIMESTAMPTZ`,
    `ALTER TABLE aegis_serp_outcomes ADD COLUMN IF NOT EXISTS feedback_last_error TEXT`,
    `UPDATE aegis_serp_outcomes SET outcome_key = md5(COALESCE(url, '') || '|' || published_at::text || '|' || id::text) WHERE outcome_key IS NULL`,
    `UPDATE aegis_serp_outcomes SET measure_after_at = published_at + INTERVAL '14 days' WHERE measure_after_at IS NULL`,
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_serp_outcomes_outcome_key ON aegis_serp_outcomes(outcome_key) WHERE outcome_key IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_due ON aegis_serp_outcomes(status, measure_after_at, next_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS idx_aegis_serp_outcomes_feedback_due ON aegis_serp_outcomes(status, feedback_next_attempt_at) WHERE status = 'measured'`,

    `ALTER TABLE aegis_brain_versions ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'deployed'`,
    `ALTER TABLE aegis_brain_versions ADD COLUMN IF NOT EXISTS artifact_sha VARCHAR(64)`,
    `ALTER TABLE aegis_brain_versions ADD COLUMN IF NOT EXISTS artifact_type VARCHAR(40) NOT NULL DEFAULT 'dspy_compiled'`,
    `ALTER TABLE aegis_brain_versions ADD COLUMN IF NOT EXISTS holdout_score NUMERIC(7,3)`,
    `ALTER TABLE aegis_brain_versions ADD COLUMN IF NOT EXISTS evaluation JSONB NOT NULL DEFAULT '{}'::jsonb`,
    `ALTER TABLE aegis_brain_versions ADD COLUMN IF NOT EXISTS deployed_by VARCHAR(80)`,
    `CREATE INDEX IF NOT EXISTS idx_aegis_brain_versions_status ON aegis_brain_versions(status, deployed_at DESC)`,

    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS published_url TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}'`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_version TEXT`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS opportunity_id UUID`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS source_snapshot_id UUID`,
    `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS success_metric JSONB`,
    `CREATE INDEX IF NOT EXISTS idx_tasks_published_url ON tasks(published_url) WHERE published_url IS NOT NULL`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS published_url TEXT`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}'`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS model_version TEXT`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS execution_token UUID`,
    `ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS published_url TEXT`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}'`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS model_version TEXT`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS execution_token UUID`,
    `ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS execution_started_at TIMESTAMPTZ`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS published_url TEXT`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS published_queries TEXT[] NOT NULL DEFAULT '{}'`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS prompt_version TEXT`,
    `ALTER TABLE meta_tag_tasks ADD COLUMN IF NOT EXISTS model_version TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_info_article_tasks_published_url ON info_article_tasks(published_url) WHERE published_url IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_link_article_tasks_published_url ON link_article_tasks(published_url) WHERE published_url IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_info_article_tasks_execution ON info_article_tasks(status, execution_token) WHERE execution_token IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_link_article_tasks_execution ON link_article_tasks(status, execution_token) WHERE execution_token IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS idx_meta_tag_tasks_published_url ON meta_tag_tasks(published_url) WHERE published_url IS NOT NULL`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS project_id UUID`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS opportunity_id UUID`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS task_id TEXT`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS measure_after_at TIMESTAMPTZ`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS measurement_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS last_error TEXT`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS feedback_status VARCHAR(16) NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS feedback_attempts INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS feedback_next_attempt_at TIMESTAMPTZ`,
    `ALTER TABLE aegis_experiments ADD COLUMN IF NOT EXISTS feedback_last_error TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_aegis_experiments_due ON aegis_experiments(status, measure_after_at, next_attempt_at)`,
    `CREATE INDEX IF NOT EXISTS idx_aegis_experiments_feedback_due ON aegis_experiments(status, feedback_status, feedback_next_attempt_at)`,

    // LLM pricing accuracy (migration 135): actual model/tier, partial cache
    // split, peak/off-peak mode and high-precision input/output costs.
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS model_tier VARCHAR(100)`,
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16)`,
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS thoughts_tokens BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS input_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0`,
    `ALTER TABLE task_stages ADD COLUMN IF NOT EXISTS output_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0`,
    `ALTER TABLE task_stages ALTER COLUMN cost_usd TYPE NUMERIC(18,12)`,
    `ALTER TABLE task_metrics ALTER COLUMN deepseek_cost_usd TYPE NUMERIC(18,12)`,
    `ALTER TABLE task_metrics ALTER COLUMN gemini_cost_usd TYPE NUMERIC(18,12)`,
    `ALTER TABLE task_metrics ALTER COLUMN grok_cost_usd TYPE NUMERIC(18,12)`,
    `ALTER TABLE task_metrics ALTER COLUMN total_cost_usd TYPE NUMERIC(18,12)`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS model VARCHAR(100)`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16)`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS thoughts_tokens BIGINT NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS input_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_llm_usage ADD COLUMN IF NOT EXISTS output_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0`,
    `ALTER TABLE aegis_llm_usage ALTER COLUMN cost_usd TYPE NUMERIC(18,12)`,
    `CREATE INDEX IF NOT EXISTS idx_task_stages_model_pricing ON task_stages(model_tier, pricing_mode, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_aegis_llm_usage_model_pricing ON aegis_llm_usage(model, pricing_mode, created_at DESC)`,
  ];

  for (const sql of statements) await db.query(sql);
}

module.exports = { ensureDurableTaskSchema };
