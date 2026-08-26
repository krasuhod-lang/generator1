-- Migration 138:
-- Preserve the third column from GSC Top Target Pages exports:
-- "Sites linking to resource" / "Сайты со ссылками на ресурс".
-- Existing rows remain valid with a zero default.

ALTER TABLE project_gsc_links
  ADD COLUMN IF NOT EXISTS referring_sites INTEGER NOT NULL DEFAULT 0;
