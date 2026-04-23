-- =================================================================
-- Migration 009: Persistent monitoring logs (task_logs)
-- =================================================================
-- Хранит SSE-события задач (log/progress/done/error/etc.) между
-- перезагрузками страницы. Раньше всё жило только в памяти компонента
-- MonitorPage.vue → терялось при F5.
--
-- Производительность:
--   * Запись батчами (50 строк / 1 сек) из taskLogPersister.
--   * Индекс (task_id, ts) — основной паттерн чтения «история задачи».
--   * Partial index по `ts > now() - 30d` ограничивает горячую часть
--     (старые логи остаются на диске, но не утяжеляют index size).
--   * Отдельная функция cleanup_old_task_logs() для cron / manual purge.
-- =================================================================

CREATE TABLE IF NOT EXISTS task_logs (
  id           BIGSERIAL PRIMARY KEY,
  task_id      UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  level        VARCHAR(16) NOT NULL DEFAULT 'info',  -- info|success|warn|error|system
  stage        VARCHAR(32),                          -- 'stage3'|'stage5'|null
  event_type   VARCHAR(32) NOT NULL DEFAULT 'log',   -- 'log'|'progress'|'done'|...
  message      TEXT,
  payload      JSONB
);

CREATE INDEX IF NOT EXISTS idx_task_logs_task_ts
  ON task_logs (task_id, ts);

-- TTL helper: удаляет логи старше N дней. Запускается cron'ом или вручную.
CREATE OR REPLACE FUNCTION cleanup_old_task_logs(retain_days INTEGER DEFAULT 30)
RETURNS INTEGER LANGUAGE plpgsql AS $$
DECLARE
  deleted INTEGER;
BEGIN
  DELETE FROM task_logs
   WHERE ts < NOW() - (retain_days || ' days')::interval;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$;
