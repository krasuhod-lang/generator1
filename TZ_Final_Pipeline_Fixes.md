# ТЗ: Финальные фиксы пайплайна генерации и Quality Gate

## Контекст
Стек: Node.js + PostgreSQL.
Пайплайн генерации SEO-текстов падает с `Invalid maxTokens` при рерайте (LinguaForensic) и блокируется Quality Gate из-за отсутствия данных `authorship`. Также при автозаполнении из отчёта релевантности теряются два важных поля.

## Чеклист задач для реализации (выполнять по порядку)

### 1. Фикс `Invalid maxTokens` в LinguaForensic
**Проблема:** В файле `backend/src/services/linguaForensic/index.js` в `runRewrite` (строка 269) жестко задан `maxTokens: 65536`. Однако `gemini.adapter.js` выбрасывает ошибку `if (maxTokens > 32000) throw new Error('Invalid maxTokens')`.
**Решение:**
- В `backend/src/services/linguaForensic/index.js` изменить `maxTokens` на `32000` для `runRewrite` и других вызовов `callLLM`, где значение превышает лимит адаптера.

### 2. Фикс `missing_disclosure` в Quality Gate
**Проблема:** В логах видим `🚦 Quality gate: Заблокировано: authorship=missing_disclosure`. Это происходит потому, что `orchestrator.js` не передаёт объект `authorship` в `qualityGate.runForTask()`, хотя YMYL-тематика требует его наличия.
**Решение:**
- В `backend/src/services/pipeline/orchestrator.js` (около строки 1070) при вызове `qualityGate.runForTask` добавить в объект `raw` поле `authorship`:
```javascript
authorship: {
  byline: task.input_author_name || 'Редакция',
  reviewer: null,
  sources: []
}
```

### 3. Автозаполнение полей `project_constraints` и `priority_page_types`
**Проблема:** Кнопка «Заполнить из отчета» в UI заполняет только ЦА, особенности ниши и факты. Поля «Ограничения проекта» и «Приоритетные типы страниц» остаются пустыми, так как контроллер их не извлекает.
**Решение:**
- В `backend/src/controllers/tasks.controller.js` в функции `_runRelevanceLlmEnrichment`:
  1. Добавить в системный промпт требование извлекать `project_constraints` и `priority_page_types`.
  2. Добавить эти поля в JSON-схему (ожидаемый формат ответа).
  3. Извлечь их через `pick('project_constraints')` и `pick('priority_page_types')`.
- В функции `getRelevancePrefill` добавить эти поля в возвращаемый объект `llm`:
```javascript
input_project_limits: llmRaw.project_constraints || '',
input_page_priorities: llmRaw.priority_page_types || '',
```

### 4. Фикс LSI Cap в Stage 5
**Проблема:** Блоки с отличным LSI (100%) иногда откатываются из-за превышения длины HTML на 1-2%.
**Решение:**
- В `backend/src/services/pipeline/stage5.js` найти все места с умножением на `1.2` (например, `Math.round(blockCharLimits.maxChars * 1.2)`) и заменить коэффициент на `1.5`, чтобы дать больше свободы для качественной LSI-инъекции.

---
**После завершения всех пунктов:**
Проверить код с помощью `node -c` для изменённых файлов.
