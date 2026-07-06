-- 099_relevance_factor_matrix.sql — SEO Relevance Analyzer 2.0, Phase 1.
--
-- Добавляет additive-колонку для «сырой факторной матрицы» одного прогона
-- анализа релевантности (row-per-page: лексические/структурные/trust/
-- commercial/readability/HTML-schema факторы + позиция URL в выдаче).
--
-- Зачем отдельная колонка, а не только внутри report JSONB:
--   §14 ТЗ — матрицу нужно уметь пересчитывать офлайн (другие корреляции,
--   Kendall, ML-важность факторов) БЕЗ повторного обхода SERP и рефетча
--   страниц. Компактный, стабильный по схеме срез удобно хранить и
--   версионировать отдельно от «толстого» человекочитаемого report.
--
-- Содержимое кол(JSONB):
--   { query, built_at, backend, n_pages, factors:[{name,group,label}],
--     page_factor_vectors:[{url, serp_position, values:{factor->number|null}}] }
--
-- Идемпотентно (ADD COLUMN IF NOT EXISTS) и продублировано в
-- backend/server.js ensureSchema (как и остальные миграции 003+).

ALTER TABLE relevance_reports ADD COLUMN IF NOT EXISTS factor_matrix JSONB;
