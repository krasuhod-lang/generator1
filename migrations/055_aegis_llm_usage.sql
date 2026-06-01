-- Migration 055: AEGIS LLM usage log — посуточный учёт расходов Эгиды.
--
--   Каждый LLM-вызов, проходящий через aegis/llmRouter (критик/писатель,
--   фолбэк-цепочки, прозрачный DeepSeek-путь), пишет сюда ОДНУ строку с
--   точным расходом: provider, тип вызова (kind), токены in/out, токены из
--   prompt-кэша (cached_tokens), стоимость в USD, признак попадания в кэш
--   (cache_hit) и итог (outcome). Источник данных для admin-раздела
--   «Расходы Эгиды по дням» (GET /api/admin/aegis-costs) — суточный ряд,
--   разбивка по провайдерам, доля кэш-хитов и итоги периода.
--
--   Зеркало Prometheus-счётчиков telemetry (aegis_cost_usd_total,
--   aegis_cache_hits_total, aegis_tokens_total), но персистентное и с
--   суточной гранулярностью для исторической аналитики и фильтра периодов.
--
--   Пишется best-effort (aegis/llmUsageLog.recordUsage) — сбой записи
--   НИКОГДА не валит пайплайн. Соответствует идемпотентному ensureSchema()
--   в backend/server.js.

CREATE TABLE IF NOT EXISTS aegis_llm_usage (
    id             BIGSERIAL     PRIMARY KEY,
    provider       VARCHAR(32)   NOT NULL,
    kind           VARCHAR(32),
    outcome        VARCHAR(16)   NOT NULL DEFAULT 'ok',  -- ok|error
    tokens_in      BIGINT        NOT NULL DEFAULT 0,
    tokens_out     BIGINT        NOT NULL DEFAULT 0,
    cached_tokens  BIGINT        NOT NULL DEFAULT 0,
    cost_usd       NUMERIC(14,6) NOT NULL DEFAULT 0,
    cache_hit      BOOLEAN       NOT NULL DEFAULT FALSE,
    latency_ms     INTEGER,
    created_at     TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS aegis_llm_usage_created_idx
    ON aegis_llm_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS aegis_llm_usage_provider_created_idx
    ON aegis_llm_usage (provider, created_at DESC);
