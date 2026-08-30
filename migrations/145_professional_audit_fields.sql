-- Professional audit evidence fields.
-- Additive migration: existing audit tasks/reports remain intact.
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS final_url TEXT;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS fetch_status TEXT;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS parse_status TEXT;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS fetch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS content_type TEXT;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS x_robots_tag TEXT;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS title_count INTEGER;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS meta_description_count INTEGER;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS canonical_count INTEGER;
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS html_lang VARCHAR(32);
ALTER TABLE audit_pages ADD COLUMN IF NOT EXISTS has_viewport BOOLEAN;

CREATE INDEX IF NOT EXISTS idx_audit_pages_task_status
  ON audit_pages(task_id, status_code, parse_status);
CREATE INDEX IF NOT EXISTS idx_audit_pages_task_fetch
  ON audit_pages(task_id, fetch_status);

UPDATE audit_pages
   SET final_url = COALESCE(final_url, url),
       parse_status = COALESCE(parse_status, CASE WHEN title IS NOT NULL THEN 'legacy' ELSE 'unknown' END),
       fetch_status = COALESCE(fetch_status, CASE WHEN status_code IS NOT NULL THEN 'ok' ELSE 'error' END)
 WHERE final_url IS NULL OR parse_status IS NULL OR fetch_status IS NULL;

-- Migration intentionally does not rewrite audit_tasks.report JSON. Existing
-- reports remain available exactly as they were persisted.
