-- Migration 060: SEO/GEO 2026 — JSON-LD blocks + author byline.
-- Колонки nullable; приложение деградирует gracefully, если они пусты.
-- См. backend/src/services/seo/geoSchema.js + geoExtractor.js.

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS article_html_with_schema TEXT,
  ADD COLUMN IF NOT EXISTS json_ld_blocks           JSONB,
  ADD COLUMN IF NOT EXISTS author_byline            TEXT;

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS article_html_with_schema TEXT,
  ADD COLUMN IF NOT EXISTS json_ld_blocks           JSONB,
  ADD COLUMN IF NOT EXISTS author_byline            TEXT;

ALTER TABLE category_lead_tasks
  ADD COLUMN IF NOT EXISTS json_ld_blocks JSONB;
