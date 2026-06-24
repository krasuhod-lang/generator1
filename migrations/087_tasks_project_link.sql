-- Migration 087: явная связь любой задачи с SEO-проектом (ТЗ §5).
--
-- Каждая таблица задач получает project_id BIGINT NULL → projects(id)
-- ON DELETE SET NULL: удаление проекта не должно каскадно сносить задачи,
-- но связь должна разрываться, чтобы UNION-список «задачи проекта» был
-- консистентным.
--
-- Существующие записи остаются с NULL — старые задачи попадают в общий
-- список «без проекта» и в UI фильтруются отдельным селектом.

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'tasks') THEN
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS ix_tasks_project_id ON tasks(project_id);
  END IF;
END $$;

ALTER TABLE info_article_tasks
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_info_article_tasks_project_id ON info_article_tasks(project_id);

ALTER TABLE link_article_tasks
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_link_article_tasks_project_id ON link_article_tasks(project_id);

ALTER TABLE meta_tag_tasks
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_meta_tag_tasks_project_id ON meta_tag_tasks(project_id);

ALTER TABLE article_topic_tasks
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_article_topic_tasks_project_id ON article_topic_tasks(project_id);

ALTER TABLE relevance_reports
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_relevance_reports_project_id ON relevance_reports(project_id);

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_forecaster_tasks_project_id ON forecaster_tasks(project_id);

ALTER TABLE serp_b2b_tasks
  ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS ix_serp_b2b_tasks_project_id ON serp_b2b_tasks(project_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'category_lead_tasks') THEN
    ALTER TABLE category_lead_tasks
      ADD COLUMN IF NOT EXISTS project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS ix_category_lead_tasks_project_id ON category_lead_tasks(project_id);
  END IF;
END $$;
