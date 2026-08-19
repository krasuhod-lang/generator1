-- Durable parser-bot queue for site parsing scans.
-- Keeps legacy parser_tasks intact and stores per-URL state for resume/retry.

CREATE TABLE IF NOT EXISTS parser_scan_tasks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id   UUID NULL REFERENCES projects(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  options      JSONB NOT NULL DEFAULT '{}'::jsonb,
  total        INT NOT NULL DEFAULT 0,
  processed    INT NOT NULL DEFAULT 0,
  succeeded    INT NOT NULL DEFAULT 0,
  failed       INT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ NULL,
  finished_at  TIMESTAMPTZ NULL,
  heartbeat_at TIMESTAMPTZ NULL,
  worker_id    TEXT NULL,
  error        TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_parser_scan_tasks_user_created
  ON parser_scan_tasks(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_parser_scan_tasks_status
  ON parser_scan_tasks(status, created_at ASC);

CREATE TABLE IF NOT EXISTS parser_scan_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES parser_scan_tasks(id) ON DELETE CASCADE,
  input_url       TEXT NOT NULL,
  normalized_url  TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued',
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NULL,
  started_at      TIMESTAMPTZ NULL,
  heartbeat_at    TIMESTAMPTZ NULL,
  finished_at     TIMESTAMPTZ NULL,
  result          JSONB NULL,
  field_status    JSONB NULL,
  evidence        JSONB NULL,
  stats           JSONB NULL,
  error_code      TEXT NULL,
  error_message   TEXT NULL,
  content_hash    TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(task_id, normalized_url)
);

CREATE INDEX IF NOT EXISTS idx_parser_scan_items_claim
  ON parser_scan_items(status, next_attempt_at, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_parser_scan_items_task_status
  ON parser_scan_items(task_id, status);
