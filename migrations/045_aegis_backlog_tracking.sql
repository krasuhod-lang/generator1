-- Migration 045: A.E.G.I.S. backlog tracking and task linkage.

ALTER TABLE IF EXISTS aegis_backlog
  ADD COLUMN IF NOT EXISTS task_ref TEXT,
  ADD COLUMN IF NOT EXISTS task_kind TEXT,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS spq_overall NUMERIC(5,2),
  ADD COLUMN IF NOT EXISTS error TEXT;

ALTER TABLE IF EXISTS info_article_tasks
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER;

ALTER TABLE IF EXISTS link_article_tasks
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER;

ALTER TABLE IF EXISTS meta_tag_tasks
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER;

ALTER TABLE IF EXISTS article_topic_tasks
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER;

ALTER TABLE IF EXISTS relevance_reports
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS aegis_issue_number INTEGER;
