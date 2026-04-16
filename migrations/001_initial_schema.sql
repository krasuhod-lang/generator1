-- =================================================================
-- SEO Genius v4.0 — Initial Database Schema
-- Migration: 001_initial_schema.sql
-- =================================================================

-- Enable UUID extension (required for gen_random_uuid())
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =================================================================
-- ENUMS
-- =================================================================

CREATE TYPE task_status AS ENUM (
  'draft',
  'queued',
  'processing',
  'completed',
  'failed'
);

CREATE TYPE stage_status AS ENUM (
  'pending',
  'running',
  'completed',
  'failed',
  'skipped'
);

-- =================================================================
-- TABLE: users
-- =================================================================

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          VARCHAR(255),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);

-- =================================================================
-- TABLE: tasks
-- =================================================================

CREATE TABLE tasks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         VARCHAR(500),
  status        task_status DEFAULT 'draft',

  -- Входные данные
  input_brand_name      TEXT,
  input_author_name     TEXT,
  input_region          TEXT,
  input_language        TEXT DEFAULT 'ru',
  input_business_type   TEXT,
  input_site_type       TEXT,
  input_target_audience TEXT,
  input_business_goal   TEXT,
  input_monetization    TEXT,
  input_project_limits  TEXT,
  input_page_priorities TEXT,
  input_niche_features  TEXT,
  input_target_service  TEXT NOT NULL,
  input_raw_lsi         TEXT,
  input_ngrams          TEXT,
  input_tfidf_json      TEXT,
  input_brand_facts     TEXT,
  input_competitor_urls TEXT,
  input_min_chars       INTEGER DEFAULT 800,
  input_max_chars       INTEGER DEFAULT 3500,
  input_tz_docx_path    TEXT,
  input_tz_parsed_json  JSONB,

  -- Результаты стадий
  stage0_result   JSONB,
  stage1_result   JSONB,
  stage2_result   JSONB,
  stage7_result   JSONB,

  -- Итоговый HTML
  full_html       TEXT,

  -- Служебные поля
  bull_job_id     TEXT,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tasks_user_id ON tasks(user_id);
CREATE INDEX idx_tasks_status  ON tasks(status);
CREATE INDEX idx_tasks_user_status ON tasks(user_id, status);

-- =================================================================
-- TABLE: task_stages
-- =================================================================

CREATE TABLE task_stages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  stage_name    VARCHAR(50)  NOT NULL,
  call_label    VARCHAR(100),
  status        stage_status DEFAULT 'pending',
  model_used    VARCHAR(100),
  prompt_size   INTEGER,
  tokens_in     INTEGER DEFAULT 0,
  tokens_out    INTEGER DEFAULT 0,
  cost_usd      NUMERIC(10,6) DEFAULT 0,
  result_json   JSONB,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_task_stages_task_id ON task_stages(task_id);

-- =================================================================
-- TABLE: task_content_blocks
-- =================================================================

CREATE TABLE task_content_blocks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  block_index     INTEGER NOT NULL,
  h2_title        TEXT,
  section_type    VARCHAR(50),
  html_content    TEXT,
  status          VARCHAR(20) DEFAULT 'pending',
  lsi_coverage    NUMERIC(5,2) DEFAULT 0,
  ngram_coverage  NUMERIC(5,2) DEFAULT 0,
  pq_score        NUMERIC(4,2) DEFAULT 0,
  audit_log_json  JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_content_blocks_task_id           ON task_content_blocks(task_id);
CREATE UNIQUE INDEX idx_content_blocks_task_block ON task_content_blocks(task_id, block_index);

-- =================================================================
-- TABLE: task_metrics
-- =================================================================

CREATE TABLE task_metrics (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id               UUID UNIQUE NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,

  -- SEO метрики
  lsi_coverage          NUMERIC(5,2) DEFAULT 0,
  ngram_coverage        NUMERIC(5,2) DEFAULT 0,
  tfidf_status          VARCHAR(50),
  eeat_score            NUMERIC(4,2) DEFAULT 0,
  pq_score              NUMERIC(4,2) DEFAULT 0,
  bm25_score            NUMERIC(8,4) DEFAULT 0,
  anti_water_count      INTEGER DEFAULT 0,
  hallucination_count   INTEGER DEFAULT 0,
  hcu_status            VARCHAR(100),
  spam_detected         BOOLEAN DEFAULT FALSE,

  -- Токены DeepSeek
  deepseek_tokens_in    INTEGER DEFAULT 0,
  deepseek_tokens_out   INTEGER DEFAULT 0,
  deepseek_cost_usd     NUMERIC(10,6) DEFAULT 0,

  -- Токены Gemini
  gemini_tokens_in      INTEGER DEFAULT 0,
  gemini_tokens_out     INTEGER DEFAULT 0,
  gemini_cost_usd       NUMERIC(10,6) DEFAULT 0,

  -- Итого
  total_tokens          INTEGER DEFAULT 0,
  total_cost_usd        NUMERIC(10,6) DEFAULT 0,

  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

-- =================================================================
-- FUNCTION: auto-update updated_at on row change
-- =================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_content_blocks_updated_at
  BEFORE UPDATE ON task_content_blocks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_task_metrics_updated_at
  BEFORE UPDATE ON task_metrics
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
