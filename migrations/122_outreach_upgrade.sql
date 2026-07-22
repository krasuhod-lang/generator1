-- ═══════════════════════════════════════════════════════════════════
-- Миграция 122: Апгрейд модуля Outreach
--   1. Фикс бага «сам себя отписал»: outreach_unsubscribes хранит токены
--      при отправке (unsubscribed_at IS NULL) и реальные отписки
--      (unsubscribed_at IS NOT NULL).
--   2. Числовая динамика keys.so в prospects (JSONB) для писем с цифрами.
-- Идемпотентна — безопасно выполнять на каждый старт.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Разделяем токены и реальные отписки
ALTER TABLE outreach_unsubscribes
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

-- Существующие записи считаем токенами (не отписками) — они были созданы
-- при постановке в очередь, а не по реальному клику "Отписаться".
-- Если нужно пометить кого-то отписанным вручную:
--   UPDATE outreach_unsubscribes SET unsubscribed_at = NOW() WHERE email = '...';

-- 2. Числовая динамика для персонализации писем
ALTER TABLE outreach_prospects
  ADD COLUMN IF NOT EXISTS dynamics_detail JSONB;
-- Формат dynamics_detail:
-- {
--   "yandex": {"trend":"growth","deviation_pct":18.2,"first":{"date":"2026-01","value":650},"last":{"date":"2026-07","value":768},"metric":"keywords_top50"},
--   "google": {"trend":"decline","deviation_pct":-42.1,"first":{"date":"2026-01","value":810},"last":{"date":"2026-07","value":469},"metric":"keywords_top50"}
-- }
