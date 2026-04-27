-- =================================================================
-- Migration 016: Article Topics — enhancements (plan B/C)
-- =================================================================
-- Дополняет таблицу article_topic_tasks тремя JSONB-колонками:
--   • trends_json       — машинно-читаемый список трендов из Фазы 2
--                         (вытягивается парсером из TRENDS_JSON-блока
--                         в конце ответа Gemini, см. main.txt).
--   • evaluator_report  — отчёт LLM-as-judge (DeepSeek), опц., гейтится
--                         ARTICLE_TOPICS_EVALUATOR_ENABLED=true.
--   • module_context_used — флаг + краткий снимок того, какие inputs
--                         действительно были подмешаны в промпт (audience
--                         digest, sibling-deep-dives и т.п.). Полезно для
--                         последующего DSPy/MIPROv2 анализа качества.
--
-- Plus — новая таблица article_topic_trends:
--   Нормализованный реестр всех трендов, которые модель когда-либо выдавала
--   пользователю. Используется для:
--     1. Дедупликации: «вы уже исследовали тренд X 14 дней назад» — warning
--        в UI при создании deep-dive.
--     2. Кросс-нишных инсайтов: один и тот же тренд встречается в нескольких
--        нишах одного пользователя → возможно мета-тренд.
--     3. История эволюции confidence/stage по тренду со временем.
--
-- Все изменения idempotent (IF NOT EXISTS), безопасны для повторного
-- применения миграции на dev-базе.
-- =================================================================

ALTER TABLE article_topic_tasks
  ADD COLUMN IF NOT EXISTS trends_json         JSONB,
  ADD COLUMN IF NOT EXISTS evaluator_report    JSONB,
  ADD COLUMN IF NOT EXISTS module_context_used JSONB;

-- Реестр трендов (один тренд = одна строка). Привязан к конкретной задаче
-- (для отсылки в карточку источник-тренда) И к user_id (для cross-task
-- запросов «у этого пользователя по этой нормализованной форме уже был
-- тренд X»).
CREATE TABLE IF NOT EXISTS article_topic_trends (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id)               ON DELETE CASCADE,
  task_id         UUID NOT NULL REFERENCES article_topic_tasks(id) ON DELETE CASCADE,

  -- Семантика тренда
  name            TEXT NOT NULL,                 -- оригинальное имя из TRENDS_JSON
  normalized_name TEXT NOT NULL,                 -- lowercased + stemmed для дедупа
  niche           TEXT NOT NULL DEFAULT '',      -- niche задачи (для cross-niche-запросов)
  stage           TEXT,                          -- early | emerging | growing
  confidence      TEXT,                          -- low | medium | high
  drivers         JSONB DEFAULT '[]'::jsonb,     -- массив строк
  signal_ids      JSONB DEFAULT '[]'::jsonb,     -- номера связанных сигналов
  vector          TEXT,
  competitor_coverage TEXT,                      -- none | partial | covered
  window_months   INTEGER DEFAULT 0,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Поиск трендов пользователя по нормализованному имени (для дедуп-запроса).
CREATE INDEX IF NOT EXISTS idx_article_topic_trends_user_norm
  ON article_topic_trends (user_id, normalized_name, created_at DESC);

-- Поиск всех трендов конкретной задачи (для UI/детальной модалки).
CREATE INDEX IF NOT EXISTS idx_article_topic_trends_task
  ON article_topic_trends (task_id);

-- Cross-niche инсайт: «один и тот же нормализованный тренд встречается у
-- меня в N разных нишах».
CREATE INDEX IF NOT EXISTS idx_article_topic_trends_user_niche
  ON article_topic_trends (user_id, niche, normalized_name);
