-- Preserve the third metric from GSC Top Linking Sites exports.
ALTER TABLE project_gsc_links
  ADD COLUMN IF NOT EXISTS target_pages INTEGER NOT NULL DEFAULT 0;
