-- ═══════════════════════════════════════════════════════════════════════════
-- 129_outreach_single_mode.sql
--
-- Рассылка теперь одна: старый («классический») режим письма удалён из кода,
-- остался единственный персональный композер (прямые конкуренты + разрыв по
-- трафику + кейсы). Миграция приводит данные в соответствие с кодом:
--
--   • outreach_campaigns.email_mode — дефолт меняем на 'provocation';
--   • все существующие кампании переводим на актуальный режим, иначе после
--     удаления classic-ветки они бы висели с несуществующим режимом.
--
-- Колонку НЕ удаляем: она остаётся историческим маркером и не мешает.
-- Идемпотентна: можно применять повторно.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE outreach_campaigns
  ADD COLUMN IF NOT EXISTS email_mode text DEFAULT 'provocation';

ALTER TABLE outreach_campaigns
  ALTER COLUMN email_mode SET DEFAULT 'provocation';

UPDATE outreach_campaigns
   SET email_mode = 'provocation'
 WHERE email_mode IS DISTINCT FROM 'provocation';
