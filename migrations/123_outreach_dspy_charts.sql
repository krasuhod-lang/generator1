-- ═══════════════════════════════════════════════════════════════════
-- Миграция 123: Доработка модуля Outreach
--   1. html_full — полный HTML письма (для корректного превью в UI;
--      html_preview обрезался до 500 символов и рвал теги).
--   2. subject_strategy — стратегия темы письма (numeric_drop | competitor
--      | question | fallback) для будущей A/B-аналитики open-rate.
--   3. manual_review_required — письмо собрано fallback-шаблоном (LLM не
--      вернул валидный/законченный текст), требует ручной проверки.
-- Идемпотентна — безопасно выполнять на каждый старт.
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE outreach_emails
  ADD COLUMN IF NOT EXISTS html_full             TEXT;

ALTER TABLE outreach_emails
  ADD COLUMN IF NOT EXISTS subject_strategy      TEXT;

ALTER TABLE outreach_emails
  ADD COLUMN IF NOT EXISTS manual_review_required BOOLEAN NOT NULL DEFAULT FALSE;
