-- Migration 057:
--   SEO-метатеги для генератора информационной статьи в блог.
--   ИИ-писатель теперь возвращает не только текст статьи, но и SEO title
--   (до 60 символов) и description (до 160 символов), строго по тематике
--   сгенерированного текста с ключевыми словами. Поля выводятся во фронте
--   отдельными блоками с кнопкой «Скопировать».
--
--   Дублируется в backend/server.js ensureSchema() для авто-применения при
--   старте Node-процесса. Этот файл — для ручного применения вне Node.

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS seo_title       TEXT;
ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS seo_description TEXT;
