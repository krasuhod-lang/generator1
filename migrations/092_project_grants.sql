-- Migration 092:
--   Раздача доступов к проектам через панель администратора.
--
--   Владение проектом по-прежнему хранится в projects.user_id (без изменений).
--   Эта миграция добавляет «гранты» — персональные доступы для других
--   зарегистрированных пользователей с ролью (viewer/analyst/manager) и
--   набором scope ([project, analyses, reports]). Soft-revoke через
--   revoked_at, чтобы сохранять историю.
--
--   Также: колонка projects.contribute_to_brain — опт-аут проекта от
--   участия в обучении «своего мозга» Эгиды (задача 2). Колонка живёт
--   здесь, чтобы один и тот же админский экран мог управлять и
--   доступом, и опт-аутом, не плодя миграций.
--
--   Дублируется в backend/server.js ensureSchema().

CREATE TABLE IF NOT EXISTS project_grants (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  role        TEXT NOT NULL,
  scopes      JSONB NOT NULL DEFAULT '["project","analyses","reports"]'::jsonb,
  granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  note        TEXT
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'project_grants_role_chk'
  ) THEN
    ALTER TABLE project_grants
      ADD CONSTRAINT project_grants_role_chk
      CHECK (role IN ('viewer','analyst','manager'));
  END IF;
END $$;

-- Один активный грант на пару (project, user). Старые revoked-записи в индексе
-- не участвуют — позволяет переоткрыть доступ без дубликатов.
CREATE UNIQUE INDEX IF NOT EXISTS uq_project_grants_active
  ON project_grants (project_id, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_project_grants_user
  ON project_grants (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_project_grants_project
  ON project_grants (project_id, granted_at DESC);

-- Аудит-лог: каждое создание/изменение/отзыв пишется отдельной строкой.
CREATE TABLE IF NOT EXISTS project_grant_events (
  id         BIGSERIAL PRIMARY KEY,
  grant_id   UUID,
  project_id UUID NOT NULL,
  user_id    UUID NOT NULL,
  actor_id   UUID,
  action     TEXT NOT NULL,        -- 'created' | 'updated' | 'revoked'
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_grant_events_project
  ON project_grant_events (project_id, created_at DESC);

-- Опт-аут проекта от обучения Эгиды (задача 2).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS contribute_to_brain BOOLEAN NOT NULL DEFAULT TRUE;
