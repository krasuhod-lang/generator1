-- =================================================================
-- Migration 013: Link Article Generator — Enhancements
-- =================================================================
-- Добавляет:
--   1. whitespace_analysis JSONB — результат нового стратегического
--      этапа white-space discovery (между Pre-Stage 0 и Stage 2).
--      Используется как для построения иерархии статьи (Stage 2),
--      так и как обязательный контекст для writer'a (Stage 3).
--   2. eeat_audit JSONB — результат E-E-A-T-аудита статьи
--      (Stage 5). Содержит scores, issues, comments. Если score
--      ниже целевого порога (см. backend/src/utils/objectiveMetrics.js
--      EEAT_PQ_TARGET = 7.5), пайплайн делает один корректировочный
--      проход writer'а.
--   3. eeat_score NUMERIC — отдельная проекция total-score из аудита,
--      нужна для индексирования и быстрых выборок в UI/админке.
--   4. gemini_cache_name TEXT — имя Gemini cachedContents (если включён
--      LINK_ARTICLE_GEMINI_CACHE_ENABLED). Сохраняется на время жизни
--      задачи; зачищается на success-пути (TTL — fallback).
-- =================================================================

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS whitespace_analysis  JSONB,
  ADD COLUMN IF NOT EXISTS eeat_audit           JSONB,
  ADD COLUMN IF NOT EXISTS eeat_score           NUMERIC(4, 2),
  ADD COLUMN IF NOT EXISTS gemini_cache_name    TEXT;

-- Индекс для админки/аналитики: задачи с проваленным E-E-A-T.
CREATE INDEX IF NOT EXISTS idx_link_article_eeat_score
  ON link_article_tasks (eeat_score)
  WHERE eeat_score IS NOT NULL;
