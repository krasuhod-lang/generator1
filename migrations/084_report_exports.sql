-- migrations/084_report_exports.sql
-- Sprint 3 PR #193: журнал экспортов отчётов (PDF / DOCX / печать).
--
-- Зачем:
--   • Аудит — кто и в каком режиме (analyst|client) скачал отчёт.
--   • Защита от двойных кликов на «Скачать PDF»: если за последние
--     N секунд уже идёт экспорт того же черновика в том же режиме —
--     контроллер может вернуть уже готовый файл вместо повторной
--     сборки.
--   • Базис для будущей фичи «история экспортов» в UI.
--
-- Поля:
--   • draft_id      — родительский черновик отчёта.
--   • user_id       — кто инициировал; NULL для публичного экспорта
--                     (по share-ссылке) — тогда заполняется shared_id.
--   • shared_id     — для публичного экспорта по ссылке /r/<uuid>.
--   • viewer_mode   — 'analyst' | 'client' — режим, в котором собран
--                     payload (см. services/reports/viewModeSanitizer.js).
--   • format        — 'pdf' | 'docx' | 'print'.
--   • status        — 'pending' | 'ready' | 'failed'.
--   • file_url      — путь/ссылка, если файл сохранён на диск/S3
--                     (для inline-стриминга можно оставить NULL).
--   • size_bytes    — размер сгенерированного файла (для метрик).
--   • duration_ms   — сколько собирался (для трендов производительности).
--   • error         — текст ошибки, если status='failed'.

CREATE TABLE IF NOT EXISTS report_exports (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id      UUID NOT NULL REFERENCES report_drafts(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  shared_id     UUID REFERENCES shared_reports(id) ON DELETE SET NULL,
  viewer_mode   VARCHAR(16) NOT NULL DEFAULT 'analyst',
  format        VARCHAR(16) NOT NULL,
  status        VARCHAR(16) NOT NULL DEFAULT 'ready',
  file_url      TEXT,
  size_bytes    BIGINT,
  duration_ms   INTEGER,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_report_exports_viewer_mode CHECK (viewer_mode IN ('analyst','client')),
  CONSTRAINT chk_report_exports_format      CHECK (format IN ('pdf','docx','print')),
  CONSTRAINT chk_report_exports_status      CHECK (status IN ('pending','ready','failed'))
);

CREATE INDEX IF NOT EXISTS idx_report_exports_draft
  ON report_exports (draft_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_report_exports_user
  ON report_exports (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;
