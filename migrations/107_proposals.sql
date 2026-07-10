-- Миграция 107: модуль «Фронт работ» (конструктор коммерческих предложений по SEO)
-- внутри раздела «Прогнозатор».
--
--   proposal_modules       — справочник модулей-конструктора (редактируемый);
--   proposal_module_tasks  — справочник задач модулей (редактируемый, seed из SEO_Front_2026);
--   proposals              — коммерческие предложения (КП);
--   proposal_tasks         — задачи, выбранные в КП (снапшот из справочника);
--   proposal_pricing       — раздел «Стоимость» КП (основной + доп. бюджет);
--   proposal_pricing_templates — прайс-лист (справочник типовых цен, /pricing).
--
-- Справочник модулей/задач редактируемый: изменения сохраняются и
-- переиспользуются во всех новых КП. Наполнение — через seed
-- (backend/src/services/proposals/seedCatalog.js), выполняется идемпотентно
-- на старте backend.
--
-- Runtime-эквивалент (idempotent) выполняется в backend/server.js.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'proposal_status') THEN
    CREATE TYPE proposal_status AS ENUM ('draft', 'sent', 'accepted', 'rejected');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS proposal_modules (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(255) NOT NULL,
  description    TEXT,
  estimated_days VARCHAR(100),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS proposal_module_tasks (
  id          VARCHAR(10) PRIMARY KEY,  -- "1.1", "3.4"
  module_id   INTEGER NOT NULL REFERENCES proposal_modules(id) ON DELETE CASCADE,
  title       VARCHAR(500) NOT NULL,
  description TEXT,
  tool        VARCHAR(255),
  priority    VARCHAR(20) NOT NULL DEFAULT 'medium', -- high / medium / low
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pmt_module ON proposal_module_tasks (module_id, sort_order);

CREATE TABLE IF NOT EXISTS proposals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            VARCHAR(255) NOT NULL,
  client           VARCHAR(255),
  manager          VARCHAR(255),
  horizon          INTEGER NOT NULL DEFAULT 3,       -- 3 или 6
  start_date       DATE,
  status           proposal_status NOT NULL DEFAULT 'draft',
  cloned_from_id   UUID REFERENCES proposals(id) ON DELETE SET NULL,
  share_token      TEXT UNIQUE,
  share_created_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_proposals_user_created ON proposals (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_proposals_share_token  ON proposals (share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS proposal_tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id      UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  module_id        INTEGER,
  module_name      VARCHAR(255),
  task_id          VARCHAR(10),     -- "3.5", "7.2"
  task_title       VARCHAR(500) NOT NULL,
  task_description TEXT,
  priority         VARCHAR(20) NOT NULL DEFAULT 'medium',
  tool             VARCHAR(255),
  month            INTEGER NOT NULL DEFAULT 1,
  responsible      VARCHAR(255),
  status           VARCHAR(20) NOT NULL DEFAULT 'not_started', -- not_started/in_progress/done
  comment          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ptasks_proposal ON proposal_tasks (proposal_id, month);

CREATE TABLE IF NOT EXISTS proposal_pricing (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id       UUID NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  item_name         VARCHAR(255) NOT NULL,
  base_budget       DECIMAL(15,2) NOT NULL DEFAULT 0,
  additional_budget DECIMAL(15,2),
  additional_note   TEXT,
  month             INTEGER,        -- NULL = «Общее»
  currency          VARCHAR(10) NOT NULL DEFAULT 'RUB',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ppricing_proposal ON proposal_pricing (proposal_id, month);

CREATE TABLE IF NOT EXISTS proposal_pricing_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_name   VARCHAR(255) NOT NULL,
  base_budget DECIMAL(15,2) NOT NULL DEFAULT 0,
  note        TEXT,
  currency    VARCHAR(10) NOT NULL DEFAULT 'RUB',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
