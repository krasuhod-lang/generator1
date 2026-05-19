-- =================================================================
-- Migration 032: Forecaster — прогнозатор сезонного спроса
-- =================================================================
-- Хранит задачи и результаты модуля «Прогнозатор»:
--   • загружается CSV/XLSX с помесячной частотностью ключевых запросов
--     (формат Wordstat-парсера),
--   • агрегируется месячный спрос,
--   • выделяются зоны падения (anomalies),
--   • строится прогноз на 12 месяцев (Holt-Winters + OLS-тренд),
--   • оценивается трафик при росте в ТОП-3/5/10 с учётом текущего
--     трафика клиента,
--   • DeepSeek формирует выводы для клиента,
--   • share_token позволяет выпустить публичную read-only ссылку.
--
-- ВСЕ JSON-поля nullable: процесс может частично завершиться (например,
-- DeepSeek-вызов упал — но прогноз уже посчитан) и всё равно быть
-- полезным пользователю.
-- =================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'forecaster_status') THEN
    CREATE TYPE forecaster_status AS ENUM (
      'queued', 'running', 'done', 'error'
    );
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS forecaster_tasks (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Произвольное имя задачи (если не указано — генерируется из даты)
  name                TEXT NOT NULL DEFAULT '',

  -- Status / progress
  status              forecaster_status NOT NULL DEFAULT 'queued',
  error_message       TEXT,

  -- Метаданные исходного файла
  source_filename     TEXT NOT NULL DEFAULT '',
  source_rows_count   INTEGER NOT NULL DEFAULT 0,
  source_columns      JSONB,            -- {phrase_col, total_col, month_cols:[{name, period:"YYYY-MM"}]}

  -- Параметры задачи: текущий трафик, регион, target_top и т.д.
  options             JSONB,

  -- Результаты вычислений
  monthly_series      JSONB,            -- [{period:"YYYY-MM", demand, phrases_count}]
  anomalies           JSONB,            -- {drops:[{from, to, severity, dropPct, ...}], summary}
  forecast            JSONB,            -- {points:[{period, value, lo, hi}], horizon, method, mape, residual_std}
  trend               JSONB,            -- {slope_per_month, intercept, direction, r_squared, ema:[…]}
  traffic_estimate    JSONB,            -- {current_traffic_input, top3:{annual, monthly:[…]}, top5:{…}, top10:{…}}
  deepseek_summary    JSONB,            -- {verdict, text, bullets:[…], cost_usd, model}

  -- DeepSeek метрики (накапливаемые)
  llm_provider        VARCHAR(16) NOT NULL DEFAULT 'deepseek',
  llm_model           TEXT,
  tokens_in           BIGINT NOT NULL DEFAULT 0,
  tokens_out          BIGINT NOT NULL DEFAULT 0,
  cost_usd            NUMERIC(12, 6) NOT NULL DEFAULT 0,

  -- Share-ссылка (выдаётся отдельным эндпоинтом по требованию пользователя)
  share_token         TEXT UNIQUE,
  share_created_at    TIMESTAMPTZ,

  -- Audit
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forecaster_user_created
  ON forecaster_tasks (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_forecaster_status
  ON forecaster_tasks (status);

CREATE INDEX IF NOT EXISTS idx_forecaster_share_token
  ON forecaster_tasks (share_token)
  WHERE share_token IS NOT NULL;
