-- 142_outreach_and_api_observability.sql
-- Additive only: preserves existing campaigns, emails, task rows and user data.

ALTER TABLE outreach_campaigns
  ADD COLUMN IF NOT EXISTS total_queued INTEGER NOT NULL DEFAULT 0;

ALTER TABLE outreach_emails
  ADD COLUMN IF NOT EXISTS html_content TEXT,
  ADD COLUMN IF NOT EXISTS text_content TEXT,
  ADD COLUMN IF NOT EXISTS attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

-- Backfill counters from source rows once; future UI reads use outreach_emails
-- directly, so queued and actually sent are never conflated again.
UPDATE outreach_campaigns c
SET total_queued = x.total_queued,
    total_sent = x.total_sent,
    total_opened = x.total_opened,
    total_clicked = x.total_clicked,
    updated_at = NOW()
FROM (
  SELECT campaign_id,
         COUNT(*)::int AS total_queued,
         COUNT(*) FILTER (WHERE sent_at IS NOT NULL)::int AS total_sent,
         COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::int AS total_opened,
         COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::int AS total_clicked
    FROM outreach_emails
   GROUP BY campaign_id
) x
WHERE c.id = x.campaign_id;

CREATE INDEX IF NOT EXISTS ix_outreach_emails_status_attempt
  ON outreach_emails(status, last_attempt_at DESC);

CREATE TABLE IF NOT EXISTS admin_api_request_ledger (
  id                 BIGSERIAL PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  provider           TEXT NOT NULL,
  model              TEXT,
  pipeline           TEXT,
  stage_name         TEXT,
  call_label         TEXT,
  task_id            UUID,
  trace_task_id      UUID,
  request_status     TEXT NOT NULL DEFAULT 'success',
  http_status        INTEGER,
  attempt            INTEGER NOT NULL DEFAULT 1,
  duration_ms        BIGINT,
  prompt_size        BIGINT,
  tokens_in          BIGINT NOT NULL DEFAULT 0,
  tokens_out         BIGINT NOT NULL DEFAULT 0,
  cached_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_hit_tokens   BIGINT NOT NULL DEFAULT 0,
  cache_miss_tokens  BIGINT NOT NULL DEFAULT 0,
  thoughts_tokens    BIGINT NOT NULL DEFAULT 0,
  input_cost_usd     NUMERIC(18,12) NOT NULL DEFAULT 0,
  output_cost_usd    NUMERIC(18,12) NOT NULL DEFAULT 0,
  cost_usd           NUMERIC(18,12) NOT NULL DEFAULT 0,
  error_code         TEXT,
  error_message      TEXT,
  meta               JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_created
  ON admin_api_request_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_provider_model
  ON admin_api_request_ledger(provider, model, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_task
  ON admin_api_request_ledger(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_admin_api_ledger_status
  ON admin_api_request_ledger(request_status, created_at DESC);

ALTER TABLE outreach_emails
  ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS provider_event_id TEXT;

CREATE INDEX IF NOT EXISTS ix_outreach_emails_provider_event
  ON outreach_emails(provider_event_id)
  WHERE provider_event_id IS NOT NULL;

COMMENT ON TABLE admin_api_request_ledger IS
  'Append-only provider attempt ledger for admin reconciliation; never used as a task result source.';
