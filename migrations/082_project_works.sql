-- migrations/082_project_works.sql
-- PR-5 эпика premium-ui-and-client-mode-implementation: журнал работ
-- SEO-специалиста (Works Log Module).
--
-- Контракт ТЗ §6.5:
--   • Хранит технические детали (`description`) для режима «Аналитик»,
--   • и понятную клиенту выжимку (`client_summary`) для режима «Клиент»
--     (PR-2, projects/viewMode.js).
--   • Сортировка по `performed_at` (когда работа выполнена), не по
--     `created_at` — таймлайн строится по дате выполнения, а не по дате
--     ввода записи в систему.
--
-- Дополнительные поля:
--   • type   — категория работы (TECH/CONTENT/LINKS/META/...); UI группирует.
--   • status — done | in_progress | planned;
--             в Client Mode «planned» работы скрываются (клиенту обещают
--             только сделанное).
--   • impact — JSONB; произвольный набор измеримых эффектов от работы
--             (например {"queries_top10": +12, "clicks_delta_pct": 8.4}),
--             выводится в Analyst Mode под карточкой работы.
--   • links  — JSONB-массив { label, url } со ссылками на пруфы (PR/коммит,
--             pageSpeed-отчёт, скриншот SERP и т.п.).

CREATE TABLE IF NOT EXISTS project_works (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  type            VARCHAR(32) NOT NULL DEFAULT 'other',
  status          VARCHAR(16) NOT NULL DEFAULT 'done',
  title           TEXT NOT NULL,
  description     TEXT,
  client_summary  TEXT,
  impact          JSONB,
  links           JSONB,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_project_works_status CHECK (status IN ('planned','in_progress','done'))
);

CREATE INDEX IF NOT EXISTS idx_project_works_project_performed
  ON project_works (project_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_works_project_status
  ON project_works (project_id, status);
