-- 126_info_article_ai_answer_trigger.sql
--
-- GEO 2026 (Google AI Overviews / Яндекс Нейро): при генерации статьи из темы,
-- сгенерированной с полем ai_answer_trigger, сохраняем этот триггер в задаче.
-- Он передаётся в §1 ЗАДАЧА IAKB, чтобы Stage 2/3 начали статью с прямого
-- ответа (lead-answer) на конкретный вопрос — главный фактор попадания в
-- нулевую выдачу нейросетей.
--
-- Идемпотентно (IF NOT EXISTS), nullable. Соответствует ensureSchema() в
-- backend/server.js.

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS ai_answer_trigger TEXT;
