-- Migration 027:
--   Хранилище отчёта постгенерационного intent-верификатора (Phase 2 / Б5).
--   Отчёт содержит article_intent (info|commercial|transactional|navigational|mixed),
--   serp_intent (доминирующий интент SERP-топа из competitor_signals или null),
--   verdict (pass|review|mismatch|na), critical (bool), recommendation,
--   details.detection.{intent,scores,signals}.
--
--   Колонка nullable: если INFO_ARTICLE_INTENT_VERIFY_ENABLED=false или у
--   задачи нет привязанного relevance_report с competitor_signals — поле
--   остаётся NULL (или verdict=na, reason=no_serp_intent).
--
--   Соответствует ensureSchema() в backend/server.js (idempotent ADD COLUMN).

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS intent_verdict JSONB;
