-- Migration 065: A.E.G.I.S. experiments — активный цикл обучения мозга (B4).
--
-- Идея: раз в сутки experimentLoop.runOnce() выбирает страницы, по которым
-- Bio-Brain менее всего уверен в предсказании (entropy-sampling), и для
-- каждой формирует «гипотезу» (top-3 рекомендации из aegis_seo_actions).
-- Результат — запись со статусом 'planned' и baseline-метриками. Дальше
-- по сценариям:
--   • dispatch  → создаём issue в aegis_backlog (или просто помечаем
--                 для ручной реализации) и переводим в 'dispatched';
--   • measure   → через measureAfterDays считаем delta_position / delta_clicks
--                 относительно baseline и пишем reward в biobrain.feedback;
--   • outcome   → won / lost / inconclusive по знаку delta_position и
--                 величине reward.
--
-- Так мозг буквально «ставит себе эксперименты» и закрывает цикл
-- predict → реальный исход → feedback. Без новых ENV.

CREATE TABLE IF NOT EXISTS aegis_experiments (
    id                      BIGSERIAL    PRIMARY KEY,
    site_key                TEXT         NOT NULL,
    target_url              TEXT         NOT NULL,
    queries                 TEXT[]       NOT NULL DEFAULT '{}',
    -- entropy/uncertainty: чем выше — тем менее уверен мозг (0..1).
    uncertainty             NUMERIC(6,4) NOT NULL DEFAULT 0,
    -- top-3 действия из action_plan, которые гипотеза предлагает применить.
    -- Каждый элемент — { action_type, target_url, payload, ... } из
    -- aegis_seo_actions.
    hypothesis              JSONB        NOT NULL DEFAULT '[]'::jsonb,
    -- Baseline-метрики на момент планирования (для diff после dispatch).
    baseline_features       REAL[]       NOT NULL DEFAULT '{}',
    baseline_feature_labels TEXT[]       NOT NULL DEFAULT '{}',
    baseline_position       NUMERIC(7,3),
    baseline_clicks         NUMERIC(12,2),
    baseline_impressions    NUMERIC(12,2),
    -- Post-метрики (заполняются при measure).
    post_features           REAL[],
    post_position           NUMERIC(7,3),
    post_clicks             NUMERIC(12,2),
    post_impressions        NUMERIC(12,2),
    -- Дельты + итоговый reward 0..1 (та же шкала, что в serpOutcomeTracker).
    delta_position          NUMERIC(7,3),
    delta_clicks            NUMERIC(12,2),
    reward                  NUMERIC(6,4),
    -- Жизненный цикл:
    --   planned → dispatched → measured → (won|lost|inconclusive)
    -- При невозможности замера (нет gsc-данных, страница не обновлялась)
    -- остаётся 'measured' с outcome 'inconclusive'.
    status                  VARCHAR(20)  NOT NULL DEFAULT 'planned',
    outcome                 VARCHAR(20),
    -- Метки времени: planned_at = created_at, остальные — заполняются по ходу.
    planned_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    dispatched_at           TIMESTAMPTZ,
    measured_at             TIMESTAMPTZ,
    -- Связи на смежные таблицы (опц.): backlog issue + serp_outcome.
    backlog_issue_number    INTEGER,
    serp_outcome_id         BIGINT,
    notes                   TEXT
);

-- Один незавершённый эксперимент на (site_key, target_url) — чтобы
-- ежедневный воркер не плодил дубликаты, пока предыдущий не дозамерится.
CREATE UNIQUE INDEX IF NOT EXISTS uq_aegis_experiments_open
    ON aegis_experiments (site_key, target_url)
    WHERE status IN ('planned', 'dispatched');

CREATE INDEX IF NOT EXISTS idx_aegis_experiments_status
    ON aegis_experiments (status, planned_at DESC);
CREATE INDEX IF NOT EXISTS idx_aegis_experiments_site
    ON aegis_experiments (site_key, planned_at DESC);
