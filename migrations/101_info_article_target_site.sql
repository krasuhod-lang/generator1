-- 101_info_article_target_site.sql — анализ сайта-площадки для блог-статьи.
--
-- Бизнес-требование: «в статье для блога важно анализ сайта делать куда будет
-- идти публикация, т.е. мы парсим контент и на основании него делаем
-- генерацию, учитываем стилистику и формат написания».
--
--   • target_site_url      — URL площадки публикации (обычно раздел блога);
--   • target_site_analysis — результат targetSiteStyle.analyzeTargetSiteStyle
--     ({ style_profile, sampled_pages, analyzed_at }), уходит в IAKB §9c.

ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS target_site_url      TEXT;
ALTER TABLE info_article_tasks ADD COLUMN IF NOT EXISTS target_site_analysis JSONB;
