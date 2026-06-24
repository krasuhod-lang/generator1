-- Migration 088: ручные правки чисел и AI-текстов в черновике отчёта (ТЗ §6).
--
-- Хранилище:
--   * report_drafts.overrides       — плоский dot-path словарь правок (числа,
--     строки, объекты). Применяется поверх собранного data на каждый рендер.
--   * report_drafts.overrides_meta  — параллельный словарь {path: {author_id,
--     author_email, updated_at}} для аудита «кто и когда поправил».
--
-- Дефолт '{}' — старые черновики продолжают работать без overrides.

ALTER TABLE report_drafts
  ADD COLUMN IF NOT EXISTS overrides       JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS overrides_meta  JSONB NOT NULL DEFAULT '{}'::jsonb;
