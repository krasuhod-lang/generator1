-- Migration 056:
--   Разрешить images_count = 0 для info-article задач — бизнес-функция
--   «Не нужны изображения». При 0 pipeline целиком пропускает Stage 4 и
--   генерацию картинок (см. backend/src/services/infoArticle/infoArticlePipeline.js).
--
-- Ранее (миграция 022) стоял CHECK (images_count BETWEEN 1 AND 6). Снимаем
-- старый constraint и пересоздаём как 0..6. Соответствует ensureSchema()
-- в backend/server.js — этот файл нужен для ручного применения вне Node.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'info_article_tasks_images_count_chk'
  ) THEN
    ALTER TABLE info_article_tasks
      DROP CONSTRAINT info_article_tasks_images_count_chk;
  END IF;

  ALTER TABLE info_article_tasks
    ADD CONSTRAINT info_article_tasks_images_count_chk
    CHECK (images_count BETWEEN 0 AND 6);
END$$;
