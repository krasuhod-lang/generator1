-- 098_quality_gate_verdict.sql — Content Generator v2, Фаза 3.
--
-- Добавляет компактный вердикт единого qualityGate.finalize()
-- ({ canPublish, blockers, warnings, gates, summary }) прямо в задачу
-- каждого из трёх пайплайнов. Это дополняет пофичерный журнал
-- quality_gate_reports (миграция 097): журнал хранит по строке на checker
-- (для истории/аналитики), а здесь — свёрнутый вердикт для быстрого
-- UI-бейджа «прошло / на ревью» в списках и на странице результата.
--
-- Идемпотентно (ADD COLUMN IF NOT EXISTS) и продублировано в
-- backend/server.js ensureSchema (как и остальные миграции 003+).

ALTER TABLE tasks              ADD COLUMN IF NOT EXISTS quality_gate JSONB;
ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS quality_gate JSONB;
ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS quality_gate JSONB;
