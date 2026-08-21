-- Migration 135: точный LLM pricing ledger.
--
-- Хранит фактическую модель, cache hit/miss, peak/off-peak режим и раздельную
-- стоимость input/output. Старые cost_usd/total_cost_usd сохраняются как total.

ALTER TABLE task_stages
  ADD COLUMN IF NOT EXISTS model_tier VARCHAR(100),
  ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thoughts_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS input_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

ALTER TABLE task_stages ALTER COLUMN cost_usd TYPE NUMERIC(18,12);

ALTER TABLE task_metrics
  ALTER COLUMN deepseek_cost_usd TYPE NUMERIC(18,12),
  ALTER COLUMN gemini_cost_usd TYPE NUMERIC(18,12),
  ALTER COLUMN grok_cost_usd TYPE NUMERIC(18,12),
  ALTER COLUMN total_cost_usd TYPE NUMERIC(18,12);

ALTER TABLE aegis_llm_usage
  ADD COLUMN IF NOT EXISTS model VARCHAR(100),
  ADD COLUMN IF NOT EXISTS pricing_mode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS cache_hit_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cache_miss_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS thoughts_tokens BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS input_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS output_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

ALTER TABLE aegis_llm_usage ALTER COLUMN cost_usd TYPE NUMERIC(18,12);

CREATE INDEX IF NOT EXISTS idx_task_stages_model_pricing
  ON task_stages (model_tier, pricing_mode, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_llm_usage_model_pricing
  ON aegis_llm_usage (model, pricing_mode, created_at DESC);
