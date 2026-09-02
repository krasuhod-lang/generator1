-- Additive only: preserve all existing provider counters and task history.
-- Qwen is a separate web-research provider and must never be folded into Gemini.

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS qwen_tokens_in BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qwen_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qwen_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS qwen_tokens_in BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qwen_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qwen_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

ALTER TABLE task_metrics
  ADD COLUMN IF NOT EXISTS qwen_tokens_in BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qwen_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS qwen_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_info_article_tasks_qwen_usage
  ON info_article_tasks (qwen_cost_usd, created_at DESC)
  WHERE qwen_tokens_in > 0 OR qwen_tokens_out > 0 OR qwen_cost_usd > 0;
CREATE INDEX IF NOT EXISTS idx_link_article_tasks_qwen_usage
  ON link_article_tasks (qwen_cost_usd, created_at DESC)
  WHERE qwen_tokens_in > 0 OR qwen_tokens_out > 0 OR qwen_cost_usd > 0;
