-- 095_site_crawler_uuid_fix.sql — фикс типов site_crawl_* колонок.
--
-- Миграция 094 ошибочно объявила site_crawl_tasks.user_id и project_id как
-- INTEGER, тогда как users.id и projects.id — UUID. В результате любой
-- запрос к /api/site-crawler/tasks (включая SELECT COUNT(*) … WHERE
-- user_id=$1 в createTask/listTasks) падал с
--   invalid input syntax for type integer: "<uuid>"
-- что в async-контроллере оборачивалось в unhandled rejection → nginx 502.
--
-- Поскольку INSERT в эти таблицы никогда не мог отработать (uuid не
-- кастуется в integer), полезных строк там быть не может: безопасно
-- пересоздать обе таблицы.
--
-- Делать ALTER COLUMN … TYPE UUID USING nullif(user_id::text,'')::uuid
-- бессмысленно (значений нет), и упрощает разворот для дев-окружений,
-- где seedAdmin/тесты могли вставить fixture-данные с битыми uuid.

DROP TABLE IF EXISTS site_crawl_pages CASCADE;
DROP TABLE IF EXISTS site_crawl_tasks CASCADE;

CREATE TABLE site_crawl_tasks (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id  UUID     NULL     REFERENCES projects(id) ON DELETE SET NULL,
  start_url   TEXT     NOT NULL,
  options     JSONB    NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT     NOT NULL DEFAULT 'queued',
    -- queued | running | done | error | cancelled | timeout
  stats       JSONB    NOT NULL DEFAULT '{}'::jsonb,
  error       TEXT     NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at  TIMESTAMPTZ NULL,
  finished_at TIMESTAMPTZ NULL
);

CREATE INDEX idx_site_crawl_tasks_user_created
  ON site_crawl_tasks(user_id, created_at DESC);

CREATE INDEX idx_site_crawl_tasks_project
  ON site_crawl_tasks(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE site_crawl_pages (
  id            BIGSERIAL PRIMARY KEY,
  task_id       BIGINT  NOT NULL REFERENCES site_crawl_tasks(id) ON DELETE CASCADE,
  url           TEXT    NOT NULL,
  depth         INTEGER NOT NULL DEFAULT 0,
  parent_url    TEXT    NULL,
  http_status   INTEGER NULL,
  content_type  TEXT    NULL,
  title         TEXT    NULL,
  h1            TEXT    NULL,
  description   TEXT    NULL,
  canonical     TEXT    NULL,
  robots        TEXT    NULL,
  fetched_at    TIMESTAMPTZ NULL,
  duration_ms   INTEGER NULL,
  error         TEXT    NULL
);

CREATE UNIQUE INDEX uq_site_crawl_pages_task_url
  ON site_crawl_pages(task_id, url);

CREATE INDEX idx_site_crawl_pages_task_depth
  ON site_crawl_pages(task_id, depth);
