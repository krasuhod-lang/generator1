-- ============================================================================
-- 119: Quality Evaluator traces (§6 ТЗ)
--
-- pipeline_traces — единый fail-open журнал LLM-вызовов и оценок качества
-- по SEO / info / link пайплайнам. composite_quality_score хранит итоговую
-- 0–100 оценку Stage 8 evaluator-first.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pipeline_traces (
  id                 BIGSERIAL PRIMARY KEY,
  stage              VARCHAR(100),
  pipeline           VARCHAR(50),
  task_id            TEXT,
  model              VARCHAR(100),
  prompt_version     VARCHAR(20),
  input_tokens       INT,
  output_tokens      INT,
  duration_ms        INT,
  quality_score      NUMERIC(5,2),
  triggered_refine   BOOLEAN DEFAULT FALSE,
  created_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_traces_pipeline_stage
  ON pipeline_traces (pipeline, stage);

CREATE INDEX IF NOT EXISTS idx_pipeline_traces_task_id
  ON pipeline_traces (task_id);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS composite_quality_score NUMERIC(5,2);

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS composite_quality_score NUMERIC(5,2);

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS composite_quality_score NUMERIC(5,2);
