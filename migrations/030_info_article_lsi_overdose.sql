-- Migration 030:
--   Хранилище отчёта по плотности LSI и переспаму
--   (backend/src/services/infoArticle/lsiDensity.service.js).
--
--   Структура JSONB:
--     {
--       verdict: 'pass'|'review'|'fail'|'na',
--       sections_total, sections_overdose, sections_low, sections_good,
--       overspam: [{ section_title, term, density_pct }],
--       thresholds: { maxPerTermPct, maxTotalPct, minTotalPct, minSectionWords },
--       per_section: [{ section_index, title, word_count, lsi_density_pct,
--                       lsi_unique_terms, lsi_hits[], overspam_terms[], status }]
--     }
--
--   Колонка nullable; для новых задач заполняется всегда после writer-этапа,
--   для исторических остаётся NULL.
--
--   Соответствует ensureSchema() в backend/server.js (idempotent ADD COLUMN).

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS lsi_overdose_report JSONB;
