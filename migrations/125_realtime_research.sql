-- 125_realtime_research.sql — Perplexity Real-Time Research для блог- и
-- ссылочных статей.
--
-- Бизнес-требование: «ссылочные статьи и статьи для блога должны использовать
-- новую функцию Perplexity (тот же алгоритм real-time research, что зашит в
-- основном SEO-пайплайне Stage 0)».
--
-- Колонка realtime_research хранит нормализованный результат Агента-Ресёрчера
-- (Perplexity sonar-pro): { realtime_facts, expert_quotes, latest_trends,
-- legal_updates }. Уходит в §2b REAL-TIME DATA соответствующей Knowledge Base
-- (IAKB / LAKB). Nullable + IF NOT EXISTS: без PERPLEXITY_API_KEY и на старых
-- задачах колонка просто пустая.

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS realtime_research JSONB;
ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS realtime_research JSONB;
