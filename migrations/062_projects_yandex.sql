-- Migration 062:
--   Интеграция модуля «Проекты» с Яндекс.Вебмастером (вторая аналитическая
--   система, симметрично Google Search Console из миграции 058).
--
--   Требование безопасности: токены Yandex OAuth (access/refresh) хранятся
--   строго в зашифрованном виде (AES-256-GCM, см.
--   backend/src/services/projects/tokenCrypto.js) — в колонках *_enc.
--
--   Дублируется в backend/server.js ensureSchema() для авто-применения при
--   старте Node-процесса. Этот файл — для ручного применения вне Node.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_connected         BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_site_url          TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_available_sites   JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_access_token_enc  TEXT;   -- зашифрованный access-токен Yandex
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_refresh_token_enc TEXT;   -- зашифрованный refresh-токен Yandex
ALTER TABLE projects ADD COLUMN IF NOT EXISTS ydx_token_expiry      TIMESTAMPTZ;
