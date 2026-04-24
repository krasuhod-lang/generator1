# Полные промты — канонический источник аналитической логики

Эта папка содержит **исходные** промты v3 (DeepSeek-агенты), которые задают
эталонную методологию для аналитического слоя SEO-генератора. Файлы 1:1
скопированы из публичной папки `Полные промты/` корня репозитория и положены
рядом с кодом, чтобы:

1. Быть доступными в любом клоне репо (включая shallow clone из cloud agent'а).
2. Служить **источником терминологии** при доработке существующих стадий
   (`backend/src/prompts/systemPrompts.js`, `backend/src/prompts/strategy/*.txt`).
3. Использоваться будущими DSPy/Python-модулями как `system_prompt` для
   `dspy.ChainOfThought` / `dspy.TypedPredictor`.

> ⚠️ **Файлы НЕ загружаются в LLM напрямую как есть.**
> Размеры 26–41 KB на файл — прямая отправка в каждом DeepSeek-вызове
> Stage 0/1/2 удлинит обработку задачи в разы и нарушит требование
> «не удлинять процесс генерации». Вместо этого их следует использовать
> как:
> - источник **терминологии** (Entity constraints, Format wedge, Trust
>   complexity, Canonical knowledge assets, JTBD, Audience language clusters);
> - источник **методологических фаз** для обогащения коротких prod-промтов;
> - reference для DSPy-сигнатур и MIPROv2-оптимизации (Python).

---

## Маппинг «файл → модуль ТЗ → текущая стадия пайплайна»

| Файл | Модуль ТЗ | Текущая стадия | Адаптер |
|------|-----------|----------------|---------|
| `09-Niche Terminology & Language Map v3.txt` | **Модуль 1** (LSI / синонимы / язык аудитории) | `stage1` (Community Voice + LSI clusters) | DeepSeek |
| `18-Entity Landscape Builder.txt` | **Модуль 1** (canonical entities, semantic clusters, entity relationships) | `stage1` (Entity Landscape) + `utils/knowledgeGraph.js` | DeepSeek |
| `23-Community Voice Miner.txt` | **Модуль 1** (реальные формулировки болей, JTBD, hidden intents) | `stage1` (Community Voice — pain_points, user_questions) | DeepSeek |
| `10-SERP Reality Check.txt` | **Модуль 2** (что хочет видеть поисковик, intent reality) | `pre_stage0` + `stage2` (taxonomy, SERP-aware blueprint) | DeepSeek |
| `24-Content Format Fit Analyzer.txt` | **Модуль 2** (Format wedge — таблица / гайд / FAQ / how-to) | `stage2` (Content Format + buyer journey) | DeepSeek |
| `17-E-E-A-T & Trust Requirement Scanner.txt` | **Модуль 2** (Trust complexity, факты, пруфы, экспертиза) | `stage5` (EEAT audit + refine) | DeepSeek |
| `19-Regulatory & Risk Scanner.txt` | **Модуль 3** (anti-hallucination, опасные утверждения) | `stage5` (E-E-A-T) + `stage7` (final audit) | DeepSeek |

## Существующие реализации (что уже есть в коде)

- **Knowledge graph + entity relationships** → `backend/src/utils/knowledgeGraph.js`
  + Stage 1 (`entity_graph`, `knowledge_graph` в `stage1.js`).
- **LSI coverage ≥ 85%** → `backend/src/utils/objectiveMetrics.js`
  (`LSI_COVERAGE_TARGET=85`) + Stage 6 refine-loop + `calculateCoverage.js`.
- **E-E-A-T scoring + refine** → `stage5.js` (`EEAT_PQ_TARGET=7.5`)
  + `linkArticle/linkArticlePipeline.js` (`runEeatAudit`).
- **AKB (article knowledge base)** инжектит контекст всех аналитических стадий
  как Gemini `systemInstruction` для Stage 3/5/6 →
  `backend/src/utils/articleKnowledgeBase.js`.
- **Pre-Stage 0 strategy** (niche map / opportunity / demand) →
  `backend/src/services/pipeline/preStage0.js` +
  `backend/src/prompts/strategy/*.txt`.

## Что ещё **не** реализовано (план следующих PR)

1. **Модуль 1 — Module Context Derive** (без новых LLM-вызовов):
   pure-function поверх `stage1Result` + `stage0Result` →
   `{ mandatory_entities, avoid_ambiguous_terms, audience_language_clusters }`
   в формате контракта ТЗ. Сохранять в `tasks.module_context` (новая колонка).
2. **Модуль 2 — Content Blueprint** (используем уже существующий Stage 2,
   расширяем JSON-схему): добавить поля `format_wedge`, `trust_complexity`,
   `claims_to_prove`, `jtbd_to_close` — DeepSeek уже вызывается, добавляем
   только новые ключи в response schema (без отдельного запроса → без
   замедления).
3. **Модуль 3 — Quality Evaluator metric** (LLM-as-Judge, опционально): новая
   стадия `stage8_evaluator` за feature flag, использует промт 19 +
   `module_context.mandatory_entities`. По умолчанию OFF — не влияет на
   текущую генерацию.

## Как обновлять

При появлении новой версии промта в публичной папке `Полные промты/` корня
репозитория — нужно скопировать обновлённый файл сюда и поднять номер версии
в имени (`v3` → `v4`). Этим занимается человек-куратор; код **не** должен
загружать файлы из публичной папки в рантайме (там может быть нестабильный
контент, не прошедший review).
