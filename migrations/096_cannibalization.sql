-- 096_cannibalization.sql — модуль «Сканер каннибализации» (SERP-overlap).
--
-- Идея: берём H1-заголовки страниц, собранные краулером (site_crawl_pages.h1),
-- как поисковые запросы, снимаем по каждому топ-N выдачу через XMLStock в
-- нужном гео (lr), затем попарно сравниваем множества URL. Если две выдачи
-- делят ≥ minCommonUrls одинаковых URL — поисковик считает запросы одним
-- интентом, а соответствующие страницы сайта каннибализируют друг друга.
--
-- user_id/project_id — UUID (как в site_crawl_*, мия 094/095). crawl_task_id —
-- BIGINT FK на site_crawl_tasks (источник H1).
--
-- ВАЖНО: миграция дублируется в server.js ensureSchema (как и остальные).

CREATE TABLE IF NOT EXISTS cannibalization_tasks (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    UUID     NULL     REFERENCES projects(id) ON DELETE SET NULL,
  crawl_task_id BIGINT   NULL     REFERENCES site_crawl_tasks(id) ON DELETE SET NULL,
  lr            TEXT     NULL,
  engine        TEXT     NOT NULL DEFAULT 'yandex',   -- yandex | google
  options       JSONB    NOT NULL DEFAULT '{}'::jsonb,
    -- { minCommonUrls, topN, maxQueries, excludeOwnDomain, useAI }
  status        TEXT     NOT NULL DEFAULT 'queued',
    -- queued | running | done | error | cancelled
  stats         JSONB    NOT NULL DEFAULT '{}'::jsonb,
  result        JSONB    NULL,     -- кластеры + матрица (см. analyzer.js)
  error         TEXT     NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at    TIMESTAMPTZ NULL,
  finished_at   TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_cannibalization_tasks_user_created
  ON cannibalization_tasks(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_cannibalization_tasks_crawl
  ON cannibalization_tasks(crawl_task_id) WHERE crawl_task_id IS NOT NULL;

-- Снятые выдачи — для прозрачности и повторного анализа без пересъёма.
CREATE TABLE IF NOT EXISTS cannibalization_serp (
  id           BIGSERIAL PRIMARY KEY,
  task_id      BIGINT  NOT NULL REFERENCES cannibalization_tasks(id) ON DELETE CASCADE,
  query        TEXT    NOT NULL,           -- H1
  source_url   TEXT    NULL,               -- страница сайта, чей это H1
  position     INTEGER NOT NULL,           -- 1..topN
  result_url   TEXT    NOT NULL,           -- URL из выдачи
  result_title TEXT    NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cannibalization_serp_task_query_pos
  ON cannibalization_serp(task_id, query, position);

CREATE INDEX IF NOT EXISTS idx_cannibalization_serp_task
  ON cannibalization_serp(task_id);
