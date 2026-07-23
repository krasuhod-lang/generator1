# ТЗ: Исправление критических багов пайплайна генерации и автозаполнение полей ЦА/Ниши

## Контекст проекта
Стек: Node.js + Express (backend), PostgreSQL.
Модели: DeepSeek v4-pro, Gemini 3.1 pro preview.

---

## Задача 1 — Исправление критических багов пайплайна генерации

В логах генерации обнаружены три критические проблемы, которые приводят к падениям, пустой трате токенов на retry и блокировке LSI-инъекции.

### 1.1 Баг: `TypeError: Assignment to constant variable` в `callLLM.js`
В функции `callLLM` (файл `backend/src/services/llm/callLLM.js`, около строки 433) при попытке удвоить `maxTokens` (автодетекция обрезанного JSON) происходит переприсвоение константы.

**Как исправить:**
В `callLLM.js` изменить объявление `maxTokens` в деструктуризации опций:
```javascript
// Было:
const {
  // ...
  temperature,
  maxTokens,
  timeoutMs,
  // ...
} = opts;

// Стало:
let { maxTokens } = opts;
const {
  // ...
  temperature,
  timeoutMs,
  // ...
} = opts;
```
Также убедиться, что внутри цикла `attempt` объект `callOpts` создается с актуальным `maxTokens`.

### 1.2 Баг: LSI-инъекция заблокирована жестким cap-лимитом
В `backend/src/services/pipeline/stage6.js` (строка 43) `expansionCap` установлен в `1.25` (увеличение HTML максимум на 25%). Это слишком жесткий лимит, из-за которого блоки с 57% и 38% LSI-покрытия отвергаются, так как инъекция слегка превышает лимит.

**Как исправить:**
В `stage6.js` изменить множитель `expansionCap` с `1.25` на `1.5`:
```javascript
// Было:
const expansionCap = Math.round(startLength * 1.25);
// ...
`(start=${startLength}, cap=min(start×1.25, blockMax×1.25)). `

// Стало:
const expansionCap = Math.round(startLength * 1.5);
// ... и обновить текст лога соответственно:
`(start=${startLength}, cap=min(start×1.5, blockMax×1.5)). `
```

### 1.3 Баг: Stage 4 (E-E-A-T аудит) падает с `JSON parse failed`
В `backend/src/services/pipeline/stage4.js` (около строки 91) вызывается `callLLM` для аудита. Из-за огромного промпта DeepSeek иногда обрезает ответ. Несмотря на фикс в `callLLM.js`, начальный `maxTokens` для Stage 4 не задан явно или слишком мал.

**Как исправить:**
В `stage4.js` при вызове `callLLM` для `auditResult` (строка 91) и `reAuditPrompt` (строка 127) явно задать `maxTokens: 4000`:
```javascript
const auditResult = await callLLM(
  // ...
  { retries: 3, taskId, stageName: 'stage4', callLabel: '4 E-E-A-T Block ' + (i + 1), temperature: 0.1, maxTokens: 4000, log, onTokens }
);
```

---

## Задача 2 — Автозаполнение всех полей формы SEO-задачи из данных релевантности

Сейчас при нажатии "Заполнить из отчета" (эндпоинт `/api/tasks/relevance-prefill/:reportId`) LLM-функция `_runRelevanceLlmEnrichment` заполняет только 3 поля: `target_audience`, `niche_features`, `brand_facts`.
Пользователь просит, чтобы также заполнялись:
- Ограничение проекта (`input_project_limits`)
- Приоритетные типы страниц (`input_page_priorities` / `priority_pages`)
- Особенности ниши (уже есть, но нужно улучшить)
- Факты, цифры, доказательства (уже есть как `brand_facts`, но нужно переименовать/расширить в промпте)

### 2.1 Backend: Расширение схемы JSON в `_runRelevanceLlmEnrichment`

**Файл:** `backend/src/controllers/tasks.controller.js`

В функции `_runRelevanceLlmEnrichment` (около строки 1319):
1. Изменить `userPrompt`, чтобы DeepSeek возвращал 5 полей:
```javascript
// В userPrompt:
`{"target_audience":"…","niche_features":"…","brand_facts":"…","project_limits":"…","priority_pages":"…"}`
```
2. Обновить инструкции в `systemMsg` и `userPrompt`, чтобы объяснить новые поля:
- `project_limits`: "Ограничения проекта (что нельзя писать, tone of voice, юридические ограничения ниши). 1-3 предложения."
- `priority_pages`: "Приоритетные типы страниц (например, коммерческие лендинги, информационные статьи, карточки товаров). 1-2 предложения."
- `brand_facts`: "Факты, цифры, доказательства экспертности (E-E-A-T), которые можно извлечь из анализа нашего URL и конкурентов."

3. В блоке `try/catch` обновить возврат функции:
```javascript
return {
  target_audience: pick('target_audience'),
  niche_features:  pick('niche_features'),
  brand_facts:     pick('brand_facts'),
  project_limits:  pick('project_limits'),
  priority_pages:  pick('priority_pages'),
};
```

### 2.2 Backend: Проброс новых полей в ответ `getRelevancePrefill`

В функции `getRelevancePrefill` (около строки 1467):
```javascript
let llm = { 
  input_target_audience: '', 
  input_niche_features: '', 
  input_brand_facts: '',
  input_project_limits: '',
  input_page_priorities: '' 
};

if (llmRaw && !llmRaw._error) {
  llm = {
    input_target_audience: llmRaw.target_audience || '',
    input_niche_features:  llmRaw.niche_features  || '',
    input_brand_facts:     llmRaw.brand_facts     || '',
    input_project_limits:  llmRaw.project_limits  || '',
    input_page_priorities: llmRaw.priority_pages  || '',
  };
  llmUsed = !!(llm.input_target_audience || llm.input_niche_features || llm.input_brand_facts || llm.input_project_limits || llm.input_page_priorities);
}
```

---

## Чеклист реализации для Claude Opus 4.8

- [ ] 1. `backend/src/services/llm/callLLM.js` — исправить баг `Assignment to constant variable` (сделать `maxTokens` через `let`).
- [ ] 2. `backend/src/services/pipeline/stage6.js` — увеличить `expansionCap` с `1.25` до `1.5` и обновить логи.
- [ ] 3. `backend/src/services/pipeline/stage4.js` — добавить `maxTokens: 4000` в оба вызова `callLLM` (строки ~91 и ~127).
- [ ] 4. `backend/src/controllers/tasks.controller.js` — в `_runRelevanceLlmEnrichment` расширить JSON-схему промпта (добавить `project_limits`, `priority_pages`).
- [ ] 5. `backend/src/controllers/tasks.controller.js` — в `_runRelevanceLlmEnrichment` добавить возврат новых полей из `parsed`.
- [ ] 6. `backend/src/controllers/tasks.controller.js` — в `getRelevancePrefill` пробросить новые поля в объект `llm` (`input_project_limits`, `input_page_priorities`).
- [ ] 7. Убедиться, что `node --check` проходит для всех изменённых файлов.
