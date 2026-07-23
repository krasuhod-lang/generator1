-- ═══════════════════════════════════════════════════════════════════
-- Миграция 124: Доработки модуля Outreach
--   1. Контакты отправителя для подписи письма (req 3):
--      sender_site       — наш сайт (ссылка «связаться»)
--      sender_telegram   — ссылка / @username в Telegram
--   2. Мессенджеры лида для связи с клиентом (req 6):
--      messengers JSONB  — [{ "type":"whatsapp|telegram|max", "url":"..." }]
--      (сами каналы/паблики не собираем — только контакт для связи)
-- Идемпотентна — безопасно выполнять на каждый старт.
-- ═══════════════════════════════════════════════════════════════════

-- 1. Контакты отправителя (для блока «связаться со мной» внизу письма)
ALTER TABLE outreach_campaigns
  ADD COLUMN IF NOT EXISTS sender_site     TEXT,
  ADD COLUMN IF NOT EXISTS sender_telegram TEXT;

-- 2. Мессенджеры компании-лида (WhatsApp / Telegram / MAX)
ALTER TABLE outreach_prospects
  ADD COLUMN IF NOT EXISTS messengers JSONB NOT NULL DEFAULT '[]'::jsonb;
