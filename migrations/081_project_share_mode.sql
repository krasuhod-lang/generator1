-- 081_project_share_mode.sql
-- PR-2 эпика premium-ui-and-client-mode-implementation: дополняем существующий
-- share-токен проекта режимом доступа (analyst|client) и сроком действия.
--
-- Зачем:
--   • Один и тот же дашборд должен открываться по публичной ссылке в одном из
--     двух режимов — «Аналитик» (полный payload) или «Клиент» (без тех. деталей).
--   • Срок действия (share_expires_at) даёт ссылке безопасный TTL без ручного
--     отзыва. NULL = бессрочно (обратная совместимость).
--
-- Старые ссылки автоматически считаются клиентскими и бессрочными — это самый
-- безопасный default: если в БД уже есть share_token, доступ остаётся, но
-- технические поля скрываются (см. backend/src/services/projects/viewMode.js).

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS share_mode TEXT NOT NULL DEFAULT 'client';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS share_expires_at TIMESTAMPTZ;

-- CHECK добавляем отдельно через DO-блок, чтобы повторный запуск миграции
-- не падал, если ограничение уже создано.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'projects_share_mode_chk'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_share_mode_chk
      CHECK (share_mode IN ('analyst', 'client'));
  END IF;
END$$;
