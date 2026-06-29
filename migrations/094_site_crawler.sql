-- 094_site_crawler.sql — собственный модуль краулера сайта (задача 3).
-- Изолировано от services/parser/, не пересекается с проектным GSC/Я.Вебмастер
-- пайплайном. start_url + options (maxPages, maxDepth, includeSubdomains,
-- respectRobots, concurrency, parseFields). Привязка к user обязательна,
-- к project — опциональна (если задана, доступ проверяется грантами Задача 1).
--
-- ВАЖНО: миграция дублируется в server.js ensureSchema (как и все остальные),
-- чтобы dev/staging накатывали схему без отдельного шага.

CREATE TABLE IF NOT EXISTS site_crawl_tasks (
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

CREATE INDEX IF NOT EXISTS idx_site_crawl_tasks_user_created
  ON site_crawl_tasks(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_site_crawl_tasks_project
  ON site_crawl_tasks(project_id) WHERE project_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS site_crawl_pages (
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

CREATE UNIQUE INDEX IF NOT EXISTS uq_site_crawl_pages_task_url
  ON site_crawl_pages(task_id, url);

CREATE INDEX IF NOT EXISTS idx_site_crawl_pages_task_depth
  ON site_crawl_pages(task_id, depth);
