-- =================================================================
-- Migration 010: LLM provider selection (Gemini | Grok)
-- =================================================================
-- Добавляет колонку llm_provider в таблицы, которые запускают тяжёлые
-- генеративные вызовы. По умолчанию — 'gemini' (back-compat).
--
-- Поддерживаемые значения: 'gemini' | 'grok'.
-- Routing для llm_provider выполняется в backend/src/services/llm/callLLM.js
-- (gemini → gemini.adapter, grok → grok.adapter, оба через прокси).
-- =================================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini';

ALTER TABLE meta_tag_tasks
  ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini';

ALTER TABLE editor_copilot_sessions
  ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini';

ALTER TABLE editor_copilot_operations
  ADD COLUMN IF NOT EXISTS llm_provider VARCHAR(16) NOT NULL DEFAULT 'gemini';

-- CHECK-констрейнты — единый whitelist значений для всех таблиц.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_llm_provider_check'
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_llm_provider_check
      CHECK (llm_provider IN ('gemini', 'grok'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'meta_tag_tasks_llm_provider_check'
  ) THEN
    ALTER TABLE meta_tag_tasks
      ADD CONSTRAINT meta_tag_tasks_llm_provider_check
      CHECK (llm_provider IN ('gemini', 'grok'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'editor_copilot_sessions_llm_provider_check'
  ) THEN
    ALTER TABLE editor_copilot_sessions
      ADD CONSTRAINT editor_copilot_sessions_llm_provider_check
      CHECK (llm_provider IN ('gemini', 'grok'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'editor_copilot_operations_llm_provider_check'
  ) THEN
    ALTER TABLE editor_copilot_operations
      ADD CONSTRAINT editor_copilot_operations_llm_provider_check
      CHECK (llm_provider IN ('gemini', 'grok'));
  END IF;
END$$;
