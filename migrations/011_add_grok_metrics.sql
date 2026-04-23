-- =================================================================
-- Migration 011: separate Grok (x.ai) token & cost columns
--
-- До этой миграции стоимость и токены вызовов Grok сваливались в
-- gemini_tokens_in / gemini_tokens_out / gemini_cost_usd, потому что
-- callLLM ветвился только на 'deepseek' / иначе. Это мешало корректно
-- видеть сколько стоит Grok-генерация.
--
-- Колонки добавляются с DEFAULT 0, поэтому существующие строки
-- task_metrics после миграции будут иметь нулевые значения для Grok.
-- =================================================================

ALTER TABLE task_metrics
  ADD COLUMN IF NOT EXISTS grok_tokens_in   INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grok_tokens_out  INTEGER       DEFAULT 0,
  ADD COLUMN IF NOT EXISTS grok_cost_usd    NUMERIC(10,6) DEFAULT 0;
