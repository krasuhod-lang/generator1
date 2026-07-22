-- ═══════════════════════════════════════════════════════════════════
-- Миграция 121: Модуль Outreach (email-рассылки)
-- ═══════════════════════════════════════════════════════════════════

-- Статусы кампании
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outreach_campaign_status') THEN
    CREATE TYPE outreach_campaign_status AS ENUM ('draft', 'active', 'paused', 'completed', 'error');
  END IF;
END $$;

-- Статусы письма
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'outreach_email_status') THEN
    CREATE TYPE outreach_email_status AS ENUM ('queued', 'sent', 'delivered', 'opened', 'clicked', 'bounced', 'complained', 'failed');
  END IF;
END $$;

-- ── Кампании ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_campaigns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  keyword         TEXT NOT NULL,               -- исходный запрос ("ремонт квартир")
  niche           TEXT,                        -- определённая ниша (DeepSeek)
  business_type   TEXT,                        -- B2B/B2C/mixed
  cities          TEXT[] NOT NULL DEFAULT '{}', -- список городов
  search_engine   TEXT NOT NULL DEFAULT 'yandex',
  depth_pages     INTEGER NOT NULL DEFAULT 3,
  daily_limit     INTEGER NOT NULL DEFAULT 30, -- писем в день (прогрев)
  warmup_week     INTEGER NOT NULL DEFAULT 1,  -- текущая неделя прогрева (1-5)
  sender_name     TEXT,                        -- имя отправителя
  sender_email    TEXT,                        -- email отправителя (из ENV)
  status          outreach_campaign_status NOT NULL DEFAULT 'draft',
  total_prospects INTEGER NOT NULL DEFAULT 0,
  total_sent      INTEGER NOT NULL DEFAULT 0,
  total_opened    INTEGER NOT NULL DEFAULT 0,
  total_clicked   INTEGER NOT NULL DEFAULT 0,
  total_replied   INTEGER NOT NULL DEFAULT 0,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outreach_campaigns_user ON outreach_campaigns(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_outreach_campaigns_status ON outreach_campaigns(status, next_run_at);

-- ── Лиды ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_prospects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id      UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url              TEXT NOT NULL,
  company_name     TEXT,
  inn              TEXT,
  emails           TEXT[] NOT NULL DEFAULT '{}',
  phones           TEXT[] NOT NULL DEFAULT '{}',
  niche            TEXT,
  city             TEXT,
  services         TEXT[] NOT NULL DEFAULT '{}',
  dynamics_yandex  TEXT,                       -- growth/decline/stagnation/null
  dynamics_google  TEXT,
  score            INTEGER NOT NULL DEFAULT 0, -- 0-100
  score_breakdown  JSONB,                      -- детали скоринга
  top_opportunities JSONB,                     -- топ-5 упущенных запросов
  status           TEXT NOT NULL DEFAULT 'new', -- new/queued/sent/replied/converted/rejected/unsubscribed
  source_serp_task UUID REFERENCES serp_b2b_tasks(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS ix_outreach_prospects_url_campaign ON outreach_prospects(url, campaign_id);
CREATE INDEX IF NOT EXISTS ix_outreach_prospects_campaign ON outreach_prospects(campaign_id, score DESC);
CREATE INDEX IF NOT EXISTS ix_outreach_prospects_status ON outreach_prospects(status, campaign_id);

-- ── Отправленные письма ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_emails (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id      UUID NOT NULL REFERENCES outreach_prospects(id) ON DELETE CASCADE,
  campaign_id      UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_email  TEXT NOT NULL,
  recipient_domain TEXT NOT NULL,
  subject          TEXT,
  html_preview     TEXT,                       -- первые 500 символов
  resend_id        TEXT UNIQUE,               -- ID из Resend API
  status           outreach_email_status NOT NULL DEFAULT 'queued',
  error_message    TEXT,
  queued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at          TIMESTAMPTZ,
  delivered_at     TIMESTAMPTZ,
  opened_at        TIMESTAMPTZ,
  clicked_at       TIMESTAMPTZ,
  replied_at       TIMESTAMPTZ,
  bounced_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_outreach_emails_campaign ON outreach_emails(campaign_id, queued_at DESC);
CREATE INDEX IF NOT EXISTS ix_outreach_emails_prospect ON outreach_emails(prospect_id);
CREATE INDEX IF NOT EXISTS ix_outreach_emails_resend ON outreach_emails(resend_id);
-- Защита от повторной отправки (cooldown 30 дней на домен)
CREATE INDEX IF NOT EXISTS ix_outreach_emails_domain_sent ON outreach_emails(recipient_domain, sent_at DESC);

-- ── Отписки ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_unsubscribes (
  email      TEXT PRIMARY KEY,
  domain     TEXT NOT NULL,
  token      TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outreach_unsubscribes_domain ON outreach_unsubscribes(domain);

-- ── Логи кампании (для UI) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_logs (
  id          BIGSERIAL PRIMARY KEY,
  campaign_id UUID NOT NULL REFERENCES outreach_campaigns(id) ON DELETE CASCADE,
  level       TEXT NOT NULL DEFAULT 'info',    -- info/warn/error/success
  message     TEXT NOT NULL,
  meta        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_outreach_logs_campaign ON outreach_logs(campaign_id, created_at DESC);

-- ── Настройки прогрева (справочник) ──────────────────────────────────
-- Лимиты по неделям прогрева: неделя → макс писем в день
CREATE TABLE IF NOT EXISTS outreach_warmup_schedule (
  week_number  INTEGER PRIMARY KEY,
  daily_limit  INTEGER NOT NULL,
  description  TEXT
);
INSERT INTO outreach_warmup_schedule (week_number, daily_limit, description) VALUES
  (1, 10,  'Прогрев: 1-я неделя — осторожный старт'),
  (2, 25,  'Прогрев: 2-я неделя — умеренный рост'),
  (3, 60,  'Прогрев: 3-я неделя — активный рост'),
  (4, 120, 'Прогрев: 4-я неделя — рабочий режим'),
  (5, 200, 'Прогрев: 5-я неделя — максимальный режим')
ON CONFLICT (week_number) DO NOTHING;
