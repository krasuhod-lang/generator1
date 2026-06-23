-- Migration 079: Smart Report Builder — TЗ modules
--
-- Поддержка модулей отчёта (ТЗ §1.4): пороги модулей на проект, результаты
-- технического аудита и мониторинг ссылочного профиля (Off-Page).
-- Стиль — VARCHAR + CHECK, без новых ENUM (см. 075_smart_reports.sql).
-- Все таблицы дублируются в backend/server.js ensureSchema().

-- 1. Пороги модулей отчёта на проект (ТЗ §3.1 project_settings).
CREATE TABLE IF NOT EXISTS project_report_settings (
  project_id            UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  ctr_low_threshold     NUMERIC(6,4) NOT NULL DEFAULT 0.02,
  ctr_high_impressions  INTEGER NOT NULL DEFAULT 500,
  striking_pos_min      INTEGER NOT NULL DEFAULT 11,
  striking_pos_max      INTEGER NOT NULL DEFAULT 20,
  report_language       VARCHAR(10) NOT NULL DEFAULT 'ru',
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Результаты технического аудита страниц (ТЗ §3.2 tech_audit_results).
CREATE TABLE IF NOT EXISTS report_tech_audit (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  audited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_images    INTEGER NOT NULL DEFAULT 0,
  images_no_alt   INTEGER NOT NULL DEFAULT 0,
  images_no_title INTEGER NOT NULL DEFAULT 0,
  images_non_webp INTEGER NOT NULL DEFAULT 0,
  page_size_kb    INTEGER NOT NULL DEFAULT 0,
  http_status     INTEGER,
  UNIQUE(project_id, url)
);

CREATE INDEX IF NOT EXISTS idx_report_tech_audit_project
  ON report_tech_audit (project_id, audited_at DESC);

-- 3. Ссылочный профиль (ТЗ §3.1 backlinks + backlink_status).
CREATE TABLE IF NOT EXISTS report_backlinks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url             TEXT NOT NULL,
  anchor          TEXT,
  donor_domain    TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checked_at      TIMESTAMPTZ,
  yandex_indexed  BOOLEAN,
  google_indexed  BOOLEAN,
  http_status     INTEGER,
  UNIQUE(project_id, url)
);

CREATE INDEX IF NOT EXISTS idx_report_backlinks_project
  ON report_backlinks (project_id, added_at DESC);
