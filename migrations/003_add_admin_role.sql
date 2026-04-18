-- =================================================================
-- SEO Genius v4.0 — Add admin role to users
-- Migration: 003_add_admin_role.sql
-- =================================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'user' NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
