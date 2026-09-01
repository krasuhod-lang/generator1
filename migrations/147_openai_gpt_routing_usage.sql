-- Migration 147: OpenAI/GPT routing and provider-specific usage accounting.
-- Additive only: existing Gemini/DeepSeek task data and defaults remain intact.

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS llm_model TEXT;

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini',
  ADD COLUMN IF NOT EXISTS llm_model TEXT,
  ADD COLUMN IF NOT EXISTS openai_tokens_in BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini',
  ADD COLUMN IF NOT EXISTS llm_model TEXT,
  ADD COLUMN IF NOT EXISTS openai_tokens_in BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;

ALTER TABLE info_article_tasks ALTER COLUMN cost_usd TYPE NUMERIC(18,12) USING cost_usd::numeric;
ALTER TABLE link_article_tasks ALTER COLUMN cost_usd TYPE NUMERIC(18,12) USING cost_usd::numeric;

ALTER TABLE task_metrics
  ADD COLUMN IF NOT EXISTS openai_tokens_in BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_tokens_out BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS openai_cost_usd NUMERIC(18,12) NOT NULL DEFAULT 0;
ALTER TABLE task_metrics ALTER COLUMN total_cost_usd TYPE NUMERIC(18,12) USING total_cost_usd::numeric;

UPDATE tasks
   SET llm_model = gemini_model
 WHERE llm_model IS NULL AND gemini_model IS NOT NULL;

UPDATE info_article_tasks
   SET llm_model = gemini_model
 WHERE llm_model IS NULL AND gemini_model IS NOT NULL;

UPDATE link_article_tasks
   SET llm_model = gemini_model
 WHERE llm_model IS NULL AND gemini_model IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_llm_provider_check') THEN
    ALTER TABLE tasks DROP CONSTRAINT tasks_llm_provider_check;
  END IF;
  ALTER TABLE tasks ADD CONSTRAINT tasks_llm_provider_check
    CHECK (llm_provider IN ('gemini', 'grok', 'openai'));

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'info_article_tasks_llm_provider_check') THEN
    ALTER TABLE info_article_tasks ADD CONSTRAINT info_article_tasks_llm_provider_check
      CHECK (llm_provider IN ('gemini', 'grok', 'openai'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'link_article_tasks_llm_provider_check') THEN
    ALTER TABLE link_article_tasks ADD CONSTRAINT link_article_tasks_llm_provider_check
      CHECK (llm_provider IN ('gemini', 'grok', 'openai'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_info_article_tasks_llm_provider
  ON info_article_tasks (llm_provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_link_article_tasks_llm_provider
  ON link_article_tasks (llm_provider, created_at DESC);
