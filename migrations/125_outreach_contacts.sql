-- Миграция 125: контактные данные отправителя для писем Outreach.
--   • sender_site     — ссылка на сайт агентства (кликабельная в подписи письма)
--   • sender_telegram — Telegram отправителя (username / ссылка / телефон),
--     используется в письме как призыв «написать в Telegram».
-- Файл идемпотентен (ADD COLUMN IF NOT EXISTS) — безопасно выполнять на каждый старт.

ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS sender_site     TEXT;
ALTER TABLE outreach_campaigns ADD COLUMN IF NOT EXISTS sender_telegram TEXT;
