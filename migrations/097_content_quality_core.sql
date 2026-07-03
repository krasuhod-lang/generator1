-- 097_content_quality_core.sql — Content Generator v2, Фаза 1.
--
-- Вводит два сквозных вектора ТЗ:
--   V6 «Prompt & Policy Registry» — редактируемые правила контента в БД
--      (stop-фразы, banned formulations, compliance-claims, YMYL-флаги),
--      чтобы их можно было менять без деплоя (раньше STOP_PHRASES были
--      захардкожены в services/pipeline/stage5.js).
--   V1 «Unified Quality Core» — журнал решений единого qualityGate.finalize()
--      (quality_gate_reports) и артефакт Information Gain (information_gain_briefs),
--      общий для всех трёх пайплайнов (tasks / link_article_tasks / info_article_tasks).
--
-- Все команды идемпотентны (IF NOT EXISTS) и продублированы в
-- backend/server.js ensureSchema (как и остальные миграции 003+), т.к.
-- /docker-entrypoint-initdb.d применяется только при первом создании volume.

-- ─────────────────────────────────────────────────────────────────────
-- V6. Реестр правил контента (editable policy).
-- scope:     global | project | locale | niche
-- rule_type: stop_phrase | banned_formulation | compliance_claim
--            | ymyl_flag | threshold | value_add_catalog
-- payload:   свободный JSONB (см. services/contentPolicy/defaults.js).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS content_policy_rules (
  id          BIGSERIAL PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT 'global',
  scope_ref   TEXT NULL,                    -- locale-код / project_id / niche-ключ (для scope != global)
  rule_type   TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_policy_rules_lookup
  ON content_policy_rules(rule_type, scope, active);

-- ─────────────────────────────────────────────────────────────────────
-- V3. Information Gain / SERP Gap brief — обязательный артефакт перед writing.
-- Одна запись на задачу любого пайплайна (pipeline_type + task_id).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS information_gain_briefs (
  id              BIGSERIAL PRIMARY KEY,
  pipeline_type   TEXT NOT NULL,            -- seo | link | info
  task_id         BIGINT NOT NULL,
  gaps            JSONB NOT NULL DEFAULT '[]'::jsonb,   -- subtopic gaps
  value_adds      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- measurable unique-value objects
  delta_score     NUMERIC NULL,            -- delta vs SERP
  blocking_reason TEXT NULL,               -- заполнено, если brief не прошёл gate
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_information_gain_briefs_task
  ON information_gain_briefs(pipeline_type, task_id);

-- ─────────────────────────────────────────────────────────────────────
-- V1. Журнал решений quality gate. По одной строке на checker на задачу
-- (перезаписывается при повторном прогоне через UNIQUE + upsert).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quality_gate_reports (
  id            BIGSERIAL PRIMARY KEY,
  pipeline_type TEXT NOT NULL,             -- seo | link | info
  task_id       BIGINT NOT NULL,
  gate_name     TEXT NOT NULL,             -- freshness | stop_phrases | lsi_overdose | ...
  pass          BOOLEAN NOT NULL,
  blocking      BOOLEAN NOT NULL DEFAULT FALSE,
  score         NUMERIC NULL,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_quality_gate_reports_task_gate
  ON quality_gate_reports(pipeline_type, task_id, gate_name);

CREATE INDEX IF NOT EXISTS idx_quality_gate_reports_task
  ON quality_gate_reports(pipeline_type, task_id);
