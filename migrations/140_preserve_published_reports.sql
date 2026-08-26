-- Preserve published reports and their public URLs.
-- This migration is intentionally additive: it never changes existing UUIDs,
-- snapshot data, draft content, or is_active/expiry choices.
DO $$
DECLARE
  existing_fk TEXT;
BEGIN
  SELECT conname
    INTO existing_fk
    FROM pg_constraint
   WHERE conrelid = 'shared_reports'::regclass
     AND confrelid = 'report_drafts'::regclass
     AND contype = 'f'
   LIMIT 1;

  IF existing_fk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE shared_reports DROP CONSTRAINT %I', existing_fk);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_shared_reports_draft_preserve'
       AND conrelid = 'shared_reports'::regclass
  ) THEN
    ALTER TABLE shared_reports
      ADD CONSTRAINT fk_shared_reports_draft_preserve
      FOREIGN KEY (draft_id) REFERENCES report_drafts(id) ON DELETE RESTRICT;
  END IF;
END $$;

DO $$
DECLARE
  existing_fk TEXT;
BEGIN
  SELECT conname
    INTO existing_fk
    FROM pg_constraint
   WHERE conrelid = 'shared_reports'::regclass
     AND confrelid = 'users'::regclass
     AND contype = 'f'
   LIMIT 1;

  IF existing_fk IS NOT NULL THEN
    EXECUTE format('ALTER TABLE shared_reports DROP CONSTRAINT %I', existing_fk);
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'fk_shared_reports_user_preserve'
       AND conrelid = 'shared_reports'::regclass
  ) THEN
    ALTER TABLE shared_reports
      ADD CONSTRAINT fk_shared_reports_user_preserve
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END IF;
END $$;
