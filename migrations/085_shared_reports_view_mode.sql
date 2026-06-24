-- migrations/085_shared_reports_view_mode.sql
-- Sprint 3 PR #193: настоящий analyst|client режим для публичных
-- ссылок на отчёт (shared_reports).
--
-- Контекст:
--   • Существующая колонка shared_reports.mode (075_smart_reports.sql)
--     означает snapshot|live (стабильный снимок данных vs. живой
--     перерасчёт), это НЕ режим клиент/аналитик.
--   • До этой миграции публичный роут /r/<uuid> хардкодил режим
--     'client' (reports.controller.js publicGet). Этого недостаточно
--     для случаев, когда специалисту нужно дать команде/руководству
--     ссылку в полном «analyst» виде (с тех. метриками модулей).
--
-- Решение: добавляем отдельную колонку `view_mode` со своим CHECK.
-- Дефолт 'client' — обратная совместимость, ни одна старая ссылка
-- не показывает больше, чем раньше.
--
-- publishShared принимает viewMode из тела запроса; publicGet
-- использует stored value, поэтому публичный роут больше не может
-- эскалировать привилегии за счёт заголовка X-Client-Mode.

ALTER TABLE shared_reports
  ADD COLUMN IF NOT EXISTS view_mode VARCHAR(16) NOT NULL DEFAULT 'client';

-- CHECK constraint добавляем условно, чтобы повторный apply не падал.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_shared_reports_view_mode'
  ) THEN
    ALTER TABLE shared_reports
      ADD CONSTRAINT chk_shared_reports_view_mode
      CHECK (view_mode IN ('analyst', 'client'));
  END IF;
END$$;
