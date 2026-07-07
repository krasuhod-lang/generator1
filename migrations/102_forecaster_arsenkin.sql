-- Migration 102: интеграция API «ARSENKIN TOOLS» в модуль «Прогнозатор».
--
-- Новый режим создания задачи: вместо CSV/XLSX-файла пользователь вводит
-- СПИСОК КЛЮЧЕВЫХ ЗАПРОСОВ. Пайплайн:
--   1) фильтр стоп-слов (бесплатно/скачать/авито/вакансии/фото/… — см.
--      backend/src/services/forecaster/stopWordFilter.js),
--   2) сбор сезонности через Арсенкин (помесячная частотность Вордстат за
--      последний год по каждой фразе) — arsenkinClient.js,
--   3) штатный анализатор: агрегация → аномалии → прогноз на 12 мес → трафик.
--
-- arsenkin_report — JSON с диагностикой сбора:
--   { verdict: 'ok'|'skipped'|'error', reason?,
--     requested, matched, region_lr, duration_ms,
--     tasks: [{task_id, phrases_count}],
--     keywords_input, keywords_kept,
--     stop_words_excluded: [{phrase, matched}] }
--
-- Токен API — env ARSENKIN_API_TOKEN (корневой .env, backend читает через
-- env_file). Дополнительно настраиваются ARSENKIN_TOOL_NAME,
-- ARSENKIN_WORDSTAT_TYPE, ARSENKIN_WORDSTAT_EXTRA, ARSENKIN_BATCH_SIZE.

ALTER TABLE forecaster_tasks
  ADD COLUMN IF NOT EXISTS arsenkin_report JSONB;
