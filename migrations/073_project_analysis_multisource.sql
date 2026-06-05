-- Migration 073:
--   Мультиисточниковая AI-аналитика «Проектов»: раздельные отчёты Google и
--   Яндекса + сводка закономерностей + детерминированный аудит факторов
--   ранжирования. Новые колонки в project_analyses.
--
--   • ydx_snapshot         — «голая» выгрузка Яндекс.Вебмастера за период;
--   • ydx_report_markdown  — отдельный AI-отчёт по Яндексу;
--   • synthesis_markdown   — сводка закономерностей Google ↔ Яндекс + рост;
--   • ranking_factors      — детерминированный аудит факторов ранжирования
--                            (чего не хватает для роста) для карточки на фронте.
--
--   Дублируется в backend/server.js ensureSchema() для авто-применения при
--   старте Node-процесса. Этот файл — для ручного применения вне Node.

ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS ydx_snapshot        JSONB;
ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS ydx_report_markdown TEXT;
ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS synthesis_markdown  TEXT;
ALTER TABLE project_analyses ADD COLUMN IF NOT EXISTS ranking_factors     JSONB;
