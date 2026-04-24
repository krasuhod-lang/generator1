-- =================================================================
-- Migration 014: Module Context + Stage 8 Evaluator report
-- =================================================================
-- Добавляет:
--   1. module_context JSONB — детерминированный контракт «Модуль 1+2»
--      (mandatory_entities, avoid_ambiguous_terms, audience_language_clusters,
--      format_wedge, trust_complexity, claims_to_prove, jtbd_to_close).
--      Собирается pure-функцией deriveModuleContext() поверх результатов
--      Stage 0/1/2 — БЕЗ дополнительных LLM-вызовов. Уезжает в AKB как
--      §11 «hard analytical constraints» для Stage 3/5/6.
--      См.: backend/src/utils/moduleContext.js,
--           backend/src/services/pipeline/orchestrator.js (после Stage 2),
--           backend/src/utils/articleKnowledgeBase.js (§11).
--
--   2. evaluator_report JSONB — отчёт опционального Stage 8
--      (LLM-as-judge на DeepSeek, промт 19 Regulatory & Risk).
--      Включается флагом STAGE8_EVALUATOR_ENABLED=true (default OFF).
--      Содержит: mandatory_entity_coverage, ambiguous_term_violations,
--      claims_supported, regulatory_risks, total_score (0..10), issues[].
--      См.: backend/src/services/pipeline/stage8.js,
--           backend/src/prompts/source/19-Regulatory & Risk Scanner.txt.
-- =================================================================

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS module_context   JSONB,
  ADD COLUMN IF NOT EXISTS evaluator_report JSONB;

-- Индексы не добавляем намеренно: оба поля читаются только при просмотре
-- конкретной задачи (по id) и для обогащения AKB. JSONB GIN-индексы
-- избыточны для текущего размера выборок.

COMMENT ON COLUMN tasks.module_context IS
  'Module Context (Module 1+2) derived deterministically from stage0/1/2 — see backend/src/utils/moduleContext.js';
COMMENT ON COLUMN tasks.evaluator_report IS
  'Optional Stage 8 evaluator report (DeepSeek LLM-as-judge, gated by STAGE8_EVALUATOR_ENABLED)';
