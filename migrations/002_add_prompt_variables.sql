-- Migration: Add new input fields for enhanced prompt variables
-- Date: 2026-04-16

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_language TEXT DEFAULT 'ru';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_business_type TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_site_type TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_target_audience TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_business_goal TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_monetization TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_project_limits TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_page_priorities TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS input_niche_features TEXT;