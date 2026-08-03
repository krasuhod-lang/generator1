-- ═══════════════════════════════════════════════════════════════════════════
-- 128_outreach_provocation.sql
--
-- Новый «провокационный» режим outreach-писем. АДДИТИВНАЯ миграция:
-- только добавляет объекты, ничего существующего не меняет и не удаляет.
-- Старый режим рассылки ('classic') продолжает работать без изменений.
--
--   • outreach_cases            — пул «наших» топ-сайтов (кейсы-доказательства),
--                                 собираются из SERP кампании по разным городам.
--                                 Поля нейтральны к нише: leads_* + lead_unit.
--   • outreach_prospects.*      — nullable-поля прогноза и конкурента (per-лид).
--   • outreach_campaigns.email_mode — переключатель режима ('classic'|'provocation').
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Пул кейсов ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS outreach_cases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid,                       -- владелец (агентство), для скоупинга
  campaign_id     uuid,                       -- кампания-источник (опц.)
  source_serp_task uuid,                      -- SERP-задача, из которой взят сайт

  domain          text NOT NULL,
  city            text,
  city_lr         text,                       -- lr-код региона Яндекса
  niche           text,
  business_type   text,

  traffic_month   integer,                    -- оценка визитов/мес (keys.so vis)
  leads_min       integer,                    -- нижняя граница заявок/мес (трафик×CR)
  leads_max       integer,                    -- верхняя граница
  lead_unit       text,                       -- 'пациент'|'клиент'|'заявка'|'заказ'…

  keywords        jsonb DEFAULT '[]'::jsonb,  -- [{phrase, volume, position}] в топ-10
  growth_pct      numeric,                    -- рост видимости за период, %

  is_client       boolean DEFAULT false,      -- реальный клиент (приоритет в подборе)
  active          boolean DEFAULT true,       -- участвует в подборе

  collected_at    timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- Один сайт на город — обновляем существующую запись (харвестер использует UPSERT).
CREATE UNIQUE INDEX IF NOT EXISTS outreach_cases_domain_city_key
  ON outreach_cases (domain, city);

-- Быстрый подбор кейсов: по нише + активности, город исключаем на уровне запроса.
CREATE INDEX IF NOT EXISTS outreach_cases_niche_active_idx
  ON outreach_cases (niche, active);
CREATE INDEX IF NOT EXISTS outreach_cases_user_idx
  ON outreach_cases (user_id);

-- ── Поля прогноза и конкурента у лида (per-лид, nullable) ────────────────────
ALTER TABLE outreach_prospects
  ADD COLUMN IF NOT EXISTS forecast_task_id       uuid,
  ADD COLUMN IF NOT EXISTS forecast_share_token   text,
  ADD COLUMN IF NOT EXISTS forecast_status        text,      -- queued|done|failed|null

  -- Список прямых конкурентов лида (несколько, а не один): сайты его же SERP
  -- в его городе, стоящие выше. Каждый: {domain, traffic, leads_min, leads_max,
  -- growing, position, top_keywords:[{phrase,volume}]}.
  ADD COLUMN IF NOT EXISTS competitors            jsonb DEFAULT '[]'::jsonb,

  -- «Якорь» — сильнейший конкурент из списка (для темы письма и заголовка).
  ADD COLUMN IF NOT EXISTS competitor_domain      text,
  ADD COLUMN IF NOT EXISTS competitor_traffic     integer,   -- визитов/мес у якоря
  ADD COLUMN IF NOT EXISTS competitor_leads_min   integer,
  ADD COLUMN IF NOT EXISTS competitor_leads_max   integer,
  ADD COLUMN IF NOT EXISTS competitor_growing     boolean,
  ADD COLUMN IF NOT EXISTS prospect_traffic       integer,   -- визитов/мес у самого лида
  ADD COLUMN IF NOT EXISTS gap_ratio              numeric,   -- competitor_traffic(якорь) / prospect_traffic
  ADD COLUMN IF NOT EXISTS lead_unit              text,      -- слово-единица под нишу лида
  ADD COLUMN IF NOT EXISTS provocation_ready      boolean DEFAULT false;

-- ── Переключатель режима письма (по умолчанию — старое поведение) ────────────
ALTER TABLE outreach_campaigns
  ADD COLUMN IF NOT EXISTS email_mode text DEFAULT 'classic';  -- 'classic' | 'provocation'
