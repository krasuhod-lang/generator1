# ТЗ: Интеграция Perplexity API (sonar-pro) в Stage 0 для сбора актуальных данных

## Контекст
Текущие модели (DeepSeek v4-pro, Gemini 3.1 pro) генерируют контент на основе устаревших обучающих данных (отставание 16-18 месяцев). Для YMYL-тематик и SEO-статей критически важно использовать актуальные цифры, ставки, законы и факты текущего месяца.
Для решения этой задачи мы интегрируем **Perplexity API** (модель `sonar-pro`) в `Stage 0` пайплайна. Perplexity будет выполнять роль "Агента-Ресёрчера", собирая свежие факты из интернета в реальном времени, которые затем будут передаваться в `Article Knowledge Base` для Gemini.

## Выбор модели
Выбрана модель **`sonar-pro`**.
*Обоснование:* Согласно актуальной документации Perplexity (2025-2026), `sonar-pro` — это продвинутая поисковая модель с grounding, поддерживающая сложные запросы. Она превосходит базовый `sonar` по качеству поиска, но работает быстрее и дешевле, чем `sonar-reasoning-pro` или `sonar-deep-research`.

## Чеклист задач для реализации (выполнять по порядку)

### 1. Добавление настроек в окружение
**Файл:** `.env.example`
- Добавить секцию для Perplexity API:
```env
# Perplexity API для актуализации данных (Stage 0)
PERPLEXITY_API_KEY=your_api_key_here
PERPLEXITY_MODEL=sonar-pro
```

### 2. Создание адаптера для Perplexity API
**Файл:** `backend/src/services/llm/perplexity.adapter.js` (создать новый файл)
- Реализовать адаптер, совместимый с интерфейсом `callLLM`.
- Использовать `https://api.perplexity.ai/chat/completions`.
- В `messages` передавать `system` и `user` промпты.
- Обязательно передавать параметры `model: process.env.PERPLEXITY_MODEL || 'sonar-pro'` и `temperature: 0.2`.
- Возвращать объект: `{ text, tokensIn, tokensOut, finishReason }`.

### 3. Регистрация адаптера в callLLM
**Файл:** `backend/src/services/llm/callLLM.js`
- Импортировать `perplexity.adapter.js`.
- Добавить поддержку `providerClass === 'perplexity-class'` и маршрутизацию вызовов к адаптеру Perplexity.
- Добавить расчет стоимости (ориентировочно $3.00/M input, $15.00/M output для sonar-pro).

### 4. Создание промпта для Perplexity (Агент-Ресёрчер)
**Файл:** `backend/src/prompts/systemPrompts.js`
- Добавить новый промпт в `SYSTEM_PROMPTS_EXT`:
```javascript
perplexityResearcher: `ROLE: Senior Research Analyst.
MISSION: Собрать самые свежие, актуальные на текущий месяц (2026 год) факты, статистику, законы и цены по теме: "{{input_target_service}}".
INSTRUCTIONS:
1. Выполни глубокий поиск в интернете.
2. Найди конкретные цифры: средние цены, ставки, проценты, изменения в законодательстве.
3. Найди 3-5 реальных цитат экспертов (с указанием Имени, Должности и Источника).
4. Найди последние тренды или новости по теме.
OUTPUT FORMAT: Верни СТРОГО валидный JSON без markdown-обёрток:
{
  "current_stats": [{"fact": "string", "value": "string", "source": "string"}],
  "expert_quotes": [{"quote": "string", "author": "string", "role": "string", "source": "string"}],
  "latest_trends": ["string"],
  "legal_or_price_updates": ["string"]
}`
```

### 5. Интеграция в Stage 0
**Файл:** `backend/src/services/pipeline/stage0.js`
- В функции `runStage0`, параллельно с `serpRealityResult` и `nicheLandscapeResult`, добавить вызов Perplexity:
```javascript
const perplexityContext = `Собери актуальные данные для темы: ${task.input_target_service}. Регион: ${task.input_region || 'Россия'}.`;

const perplexityResult = await callLLM('perplexity', fillPromptVars(SYSTEM_PROMPTS_EXT.perplexityResearcher, task), perplexityContext, {
  retries: 2,
  taskId,
  stageName: 'stage0',
  callLabel: 'Perplexity Real-Time Research',
  temperature: 0.2,
  log,
  onTokens,
}).catch(e => { log(`Stage 0 Perplexity error: ${e.message}`, 'warn'); return null; });
```
- Добавить результаты Perplexity в итоговый `stage0Result`:
```javascript
realtime_facts: perplexityResult?.current_stats || [],
expert_quotes: perplexityResult?.expert_quotes || [],
latest_trends: perplexityResult?.latest_trends || [],
legal_updates: perplexityResult?.legal_or_price_updates || [],
```

### 6. Передача актуальных данных в Article Knowledge Base
**Файл:** `backend/src/utils/articleKnowledgeBase.js`
- В функции `buildArticleKnowledgeBase` добавить новый раздел (например, `§2b. REAL-TIME DATA (2026)`).
- Если в `competitorsData` (или `stage0Result`) есть `realtime_facts`, `expert_quotes`, `latest_trends`, `legal_updates`, форматировать их и добавлять в контекст.
- Указать Gemini явно: *"Используй эти актуальные факты и реальные цитаты экспертов в тексте вместо выдуманных данных."*

### 7. Обновление промпта Stage 3 (Жёсткие правила форматирования)
**Файл:** `backend/src/prompts/infoArticle/stage3_writer.js` (и аналогичные)
- Добавить в начало `systemMsg` жёсткие правила для снижения retry:
```text
CRITICAL FORMATTING RULES:
1. КАЖДЫЙ абзац должен содержать не более 3 предложений. НИКАКИХ "стен текста".
2. Обязательно используй маркированные списки (<ul>/<li>) или таблицы (<table>) в каждом блоке для удобства сканирования.
3. Используй реальные факты и цитаты из §2b REAL-TIME DATA. Если используешь цитату, обязательно указывай автора и должность.
```
