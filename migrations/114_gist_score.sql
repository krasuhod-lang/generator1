-- ============================================================================
-- 114: GIST Score в Quality Gate (ТЗ «GIST Content Logic», Задача B §3.2)
--
-- gist_score = |{параграфов, покрывающих ≥1 тезис information_delta}| /
--              |всех параграфов| * 100 (INT, 0–100).
-- Считается 12-м чекером qualityCore (gistScoreChecker) после Quality Gate;
-- warning, не blocker (fail-open). NULL — дельта не была доступна.
--
-- tasks               — SEO-пайплайн (Stage 0 → GIST M3 Gap Finder)
-- info_article_tasks  — инфо-пайплайн (Stage 1B → GIST M3 Gap Finder)
-- link_article_tasks  — ссылочный пайплайн (задел на будущее)
-- article_tasks       — gist_py-пайплайн: колонка уже создана в 113 (no-op)
-- ============================================================================

ALTER TABLE tasks              ADD COLUMN IF NOT EXISTS gist_score INT DEFAULT NULL;
ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS gist_score INT DEFAULT NULL;
ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS gist_score INT DEFAULT NULL;
ALTER TABLE article_tasks      ADD COLUMN IF NOT EXISTS gist_score NUMERIC(5,2) DEFAULT NULL;
