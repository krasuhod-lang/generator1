-- 109_audit_share.sql — публичный шаринг отчёта аудита для клиентов.
-- Токен-ссылка /audit/share/:token с ограниченным сроком жизни, view_count и
-- настраиваемым блоком «Что мы исправим» (fix_note).
--
-- ВАЖНО: миграция дублируется в server.js ensureSchema (как и все остальные).

CREATE TABLE IF NOT EXISTS audit_share_links (
  token      VARCHAR(32) PRIMARY KEY,
  task_id    UUID NOT NULL REFERENCES audit_tasks(id) ON DELETE CASCADE,
  fix_note   TEXT NULL,              -- зелёный блок «Что мы исправим»
  expires_at TIMESTAMPTZ NOT NULL,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_share_links_task
  ON audit_share_links(task_id);
