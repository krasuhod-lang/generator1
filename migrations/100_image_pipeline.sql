-- 100_image_pipeline.sql — Content-grounded image pipeline.
--
-- Добавляет хранилище отчётов нового image-пайплайна в задачи генераторов
-- статей (info/link):
--   • image_semantic_qa_report — результат semanticImageQa.service
--     (per-slot relevance/usefulness/generic/… + article verdict);
--   • image_gate               — вердикт imageQualityGate (canFinalize,
--     blockers, warnings, summary).
--
-- Обогащённые поля отдельного слота (image_intent, value_reason, scene_json,
-- generic_risk, placement_mode, anchor_block_id, caption_ru, filename_slug,
-- storage_mode, image_url, semantic_qa_result, semantic_qa_scores) хранятся
-- ВНУТРИ существующей JSONB-колонки image_prompts (массив слотов) и не
-- требуют отдельных колонок — старые задачи просто не имеют этих ключей.
--
-- Все колонки nullable и добавляются идемпотентно (ADD COLUMN IF NOT EXISTS):
-- старые задачи и legacy-flow (флаги IMAGE_PIPELINE_* выключены) не ломаются.
-- Продублировано в backend/server.js ensureSchema (как миграции 003+).

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS image_semantic_qa_report JSONB;
ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS image_gate               JSONB;

ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS image_semantic_qa_report JSONB;
ALTER TABLE link_article_tasks ADD COLUMN IF NOT EXISTS image_gate               JSONB;
