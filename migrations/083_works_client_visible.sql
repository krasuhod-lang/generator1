-- migrations/083_works_client_visible.sql
-- Sprint 3 PR #193: добавляет флаг `client_visible` к project_works.
--
-- Зачем: ТЗ §6.5 говорит, что в Client Mode видны только работы со
-- статусом `done` (см. PR-5/082) — но иногда SEO-специалисту нужно
-- временно скрыть от клиента уже сделанную работу (например, пока
-- результат ещё не закрепился), не удаляя саму запись и не меняя
-- статус. Флаг `client_visible` решает это в один клик.
--
-- Дефолт TRUE — обратная совместимость, ничего не прячется.
-- В Client Mode `worksService.listWorks` фильтрует `client_visible IS TRUE`
-- дополнительно к `status <> 'planned'`.

ALTER TABLE project_works
  ADD COLUMN IF NOT EXISTS client_visible BOOLEAN NOT NULL DEFAULT TRUE;

-- Частичный индекс для быстрого пути client-режима
-- (он же даёт быстрый count работ, видимых клиенту).
CREATE INDEX IF NOT EXISTS idx_project_works_client_visible
  ON project_works (project_id, performed_at DESC)
  WHERE client_visible = TRUE;
