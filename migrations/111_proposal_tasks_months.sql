-- Миграция 111: несколько месяцев на 1 пункт работ + периодичность
-- («дорожная карта» КП — «Фронт работ»).
--
--   Раньше proposal_tasks.month хранил ровно один месяц выполнения задачи.
--   Теперь задача может выполняться в нескольких месяцах (ежемесячно,
--   через месяц, или в произвольном наборе месяцев) — источник истины:
--   proposal_tasks.months (INTEGER[]). Колонка month остаётся (первый/
--   минимальный месяц из months) — для обратной совместимости, сортировки
--   и индекса.

ALTER TABLE proposal_tasks
  ADD COLUMN IF NOT EXISTS months     INTEGER[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS recurrence VARCHAR(20) NOT NULL DEFAULT 'once'; -- once / monthly / every_2_months / custom

-- Бэкофилл: для существующих задач months = [month].
UPDATE proposal_tasks SET months = ARRAY[month] WHERE months = '{}';
