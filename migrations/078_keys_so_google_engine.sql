-- Migration 078: Keys.so — раздельное хранение видимости Яндекс / Google.
--
-- Keys.so использует параметр `base` для выбора поисковой системы:
--   msk/spb/... — Яндекс, gru/gkv/gmns/gny — Google.
-- Добавляем колонку search_engine к keys_so_cache и обновляем UNIQUE-constraint,
-- чтобы хранить отдельные ряды для каждой ПС.

-- 1. Новая колонка (все существующие данные — Яндекс).
ALTER TABLE keys_so_cache
  ADD COLUMN IF NOT EXISTS search_engine VARCHAR(8) NOT NULL DEFAULT 'yandex';

-- 2. Заменяем UNIQUE(domain, date) → UNIQUE(domain, date, search_engine).
--    Сначала дропаем старый constraint (имя сгенерировано PG или задано явно).
DROP INDEX IF EXISTS keys_so_cache_domain_date_key;
ALTER TABLE keys_so_cache
  DROP CONSTRAINT IF EXISTS keys_so_cache_domain_date_key;

CREATE UNIQUE INDEX IF NOT EXISTS keys_so_cache_domain_date_engine_key
  ON keys_so_cache (domain, date, search_engine);
