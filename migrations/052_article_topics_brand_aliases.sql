-- Migration 052: brand aliases + semantic fingerprint.
--
-- Зачем: пользователь может писать один и тот же бренд разными словоформами
-- ("Бренд Х", "brand-x", "Brand X Pro", "BrandX"). Без алиасов каждая
-- словоформа становится отдельным brand_key, и history dedup ломается.
--
-- article_topics_brand_aliases:
--   • brand_key_canonical — основной ключ бренда (после resolveBrandKey)
--   • brand_alias_key     — алиас, который мапится на canonical
--   • source: 'manual' | 'heuristic' | 'llm'  — откуда пришёл алиас
--   • confidence: 0..1   — уверенность (для heuristic/llm)
--
-- Чтение: brandAliases.resolveBrandKey(rawBrand, userId) → canonical
--   (если alias не найден — возвращает normalizeBrandKey(rawBrand)).
--
-- ALTER article_topics_brand_history:
--   • semantic_fingerprint JSONB — топ-N лемм/n-грамм по теме (для
--     AI-расширения семантики и Avoidance/Growth-zone подсказок)

CREATE TABLE IF NOT EXISTS article_topics_brand_aliases (
    id                    BIGSERIAL    PRIMARY KEY,
    user_id               UUID         NOT NULL,
    brand_key_canonical   TEXT         NOT NULL,
    brand_alias_key       TEXT         NOT NULL,
    source                TEXT         NOT NULL DEFAULT 'manual',
    confidence            REAL,
    created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, brand_alias_key)
);

CREATE INDEX IF NOT EXISTS idx_brand_aliases_user_canonical
    ON article_topics_brand_aliases (user_id, brand_key_canonical);

ALTER TABLE article_topics_brand_history
    ADD COLUMN IF NOT EXISTS semantic_fingerprint JSONB;
