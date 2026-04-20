-- Add target URL field for the page being promoted
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_target_url TEXT;
