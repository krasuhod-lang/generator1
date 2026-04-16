-- SEO Genius v4.0 — Initial Database Schema
-- PostgreSQL 16

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name              VARCHAR(500) NOT NULL,
  status            VARCHAR(50) DEFAULT 'pending',
  error_message     TEXT,

  -- Input fields (user-provided or auto-filled from TZ)
  input_keyword             TEXT,
  input_niche               TEXT,
  input_target_audience     TEXT,
  input_tone_of_voice       VARCHAR(100),
  input_region              VARCHAR(255),
  input_language            VARCHAR(100) DEFAULT 'русский',
  input_competitor_urls     TEXT,
  input_content_type        VARCHAR(100),
  input_brand_name          VARCHAR(255),
  input_unique_selling_points TEXT,
  input_word_count          INTEGER DEFAULT 3000,
  input_additional          TEXT,

  -- Stage results (JSONB)
  stage0_result    JSONB,
  stage1_result    JSONB,
  stage2_result    JSONB,
  stage7_result    JSONB,
  full_html        TEXT,

  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

-- Content blocks (Stage 3-6 output)
CREATE TABLE IF NOT EXISTS task_content_blocks (
  id              SERIAL PRIMARY KEY,
  task_id         INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  block_index     INTEGER NOT NULL,
  block_title     VARCHAR(500),
  html_content    TEXT,
  lsi_coverage    REAL,
  pq_score        REAL,
  audit_log_json  JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Task metrics (Stage 7 output)
CREATE TABLE IF NOT EXISTS task_metrics (
  id              SERIAL PRIMARY KEY,
  task_id         INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  lsi_coverage    REAL,
  eeat_score      REAL,
  bm25_score      REAL,
  total_tokens    INTEGER,
  total_cost      REAL,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tasks_user_id ON tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_content_blocks_task_id ON task_content_blocks(task_id);
CREATE INDEX IF NOT EXISTS idx_task_metrics_task_id ON task_metrics(task_id);
