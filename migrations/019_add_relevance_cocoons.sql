-- =================================================================
-- Migration 019: Relevance — semantic cocoons (SVD/LSI) + raw cache
-- =================================================================
-- Расширяет relevance_reports под PR 2:
--   * cocoons        — JSONB-результат прохода TruncatedSVD по корпусу
--                      (темы + топовые леммы + попавшие документы);
--   * raw_storage    — 'redis' | 'none' (где лежит processed_documents);
--   * raw_expires_at — момент истечения TTL в Redis (для UI badge).
-- Сами processed_documents в Postgres НЕ кладём — они живут в Redis
-- по ключу relevance:raw:{report_id} с TTL (default 7 дней).
-- =================================================================

ALTER TABLE relevance_reports
  ADD COLUMN IF NOT EXISTS cocoons         JSONB,
  ADD COLUMN IF NOT EXISTS raw_storage     TEXT DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS raw_expires_at  TIMESTAMPTZ;

-- Частичный индекс для UI («какие отчёты ещё имеют живой raw-кэш»).
CREATE INDEX IF NOT EXISTS idx_relevance_reports_raw_alive
  ON relevance_reports (raw_expires_at)
 WHERE raw_storage = 'redis' AND raw_expires_at IS NOT NULL;
