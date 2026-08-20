# Аудит разделов «Проекты» и «Отчёты»

**Репозиторий:** `krasuhod-lang/generator1`  
**Дата:** 20 августа 2026 года  
**Цель:** определить, насколько Projects и Reports работают как единая аналитическая система и какие изменения сильнее всего повлияют на ценность продукта для клиента.

## Executive summary

В текущей реализации уже собран сильный фундамент. Projects умеет получать данные GSC, Яндекс.Вебмастера, Keys.so и позиций, строить period compare, page decay, commercial/cannibalization, page meta audit, link audit, E-E-A-T, schema, blog, GEO/AEO и action plan. Reports умеет объединять KPI, графики, задачи, source completeness, headline, forecast, traffic value, ручные overrides и публикацию live/snapshot.

Главная проблема не в отсутствии аналитических функций, а в отсутствии **единого слоя принятия решений**. Projects analysis сохраняет больше полезных growth signals, чем Smart Reports показывает клиенту. Opportunity-модули backend не представлены отдельным client-first блоком в `ReportRenderer.vue`, а AI-summary остаётся нарративом, не связанным с stable evidence IDs, URL/query, owner, success metric и статусом выполнения.

Из-за этого система сейчас больше похожа на набор хороших аналитических экранов, чем на замкнутый growth loop:

> данные → доказанный сигнал → приоритет → задача → выполнение → повторный замер → подтверждённый эффект.

Наиболее важные изменения: перевести Project analysis и Report summary на durable jobs, связать Reports с completed analysis/snapshot, нормализовать opportunities, добавить data confidence/provenance и сформировать отдельную клиентскую проекцию отчёта.

## Что уже работает хорошо

| Область | Сильная сторона |
|---|---|
| Sources | GSC и Яндекс анализируются независимо; частичный отказ одного источника не обязан уничтожать данные другого. |
| Data assembly | `dataAggregator` объединяет источники, период, series, tasks, modules, completeness, traffic value, forecast и headline. |
| Analysis depth | `analysisRunner` имеет широкие детерминированные слои: commercial, SERP verification, breakdowns, period compare, page decay, brand split, seasonality, meta, links, E-E-A-T, schema, blog, GEO/AEO, top-page insights и action plan. |
| Period discipline | Есть completed/partial month logic, source freshness и предупреждение о неполном периоде. |
| Client safety | Есть client/analyst sanitizer, public link, PIN, live/snapshot и экспортные маршруты. |
| Editing | Есть manual overrides, WYSIWYG tasks, debounce save и flush перед публикацией/export. |
| Existing growth signals | Modules уже считают striking distance, CTR gaps, content health, off-page и technical audit. |

## Главные разрывы

### P0: Projects и Reports не используют один source of truth

Project analysis сохраняется в `project_analyses` и snapshots, включая `ranking_factors`, `synthesis_markdown`, `action_plan` и богатые growth layers. При этом Reports в основном агрегирует собственный payload из источников и AI summary. Автоматическая связь последнего completed analysis с draft/report не является обязательным контрактом.

**Риск:** экран Projects может рекомендовать одно, а клиентский Report — другое или вообще не показать наиболее ценные точки роста.

**Решение:** ввести обязательные `analysis_id`, `snapshot_id`, `report_model_version` и единый normalized payload.

### P0: Потеря задач после перезапуска

`projects.controller.startAnalysis` и endpoint генерации summary запускают работу через `setImmediate`. Если сервер перезапустился между созданием записи и завершением операции, `project_analyses` или `report_drafts.llm_status` могут остаться в `queued/running` без durable recovery.

**Решение:** перевести фоновые операции на существующий durable outbox/worker/lease/heartbeat/reconciler pattern, уже применённый к основным генераторным задачам.

### P0: Growth modules не доходят до клиентского отчёта

Backend уже формирует striking distance, CTR gap, content health, off-page и technical audit. Однако `ReportRenderer.vue` не содержит отдельной visual branch для `data.modules`, `client_safe_summary` или opportunity records.

**Решение:** добавить client-first `Growth Overview` с top opportunities, evidence, URL/query, impact, confidence, action и success metric.

### P0: AI narrative имеет опасный bias

Текущий AI summary prompt просит подчёркивать позитив, минимизировать снижение, называть сезонность/обновление алгоритмов/конкурентов возможными причинами и одновременно запрещает выдумывать числа. Такой контракт может создать уверенный текст без достаточного evidence.

**Решение:** разделить `observed_fact`, `hypothesis`, `recommendation`, `risk` и `forecast`. Неподтверждённая причинность не должна отображаться как факт.

### P1: Client mode слишком близок к analyst mode

`viewModeSanitizer` снимает технические поля и ограничивает массивы, но не формирует отдельную клиентскую narrative model. Публичный пользователь продолжает получать структуру, ориентированную на аналитика.

**Решение:** backend должен отдавать отдельную projection: `result → interpretation → opportunity → action → measurement`, а analyst projection должна сохранять raw data и diagnostics.

### P1: Потеря ручных AI-изменений

`ReportEditorPage.flushSummary` сохраняет только часть summary-полей и не включает все существующие `llm_growth`, `llm_vulnerabilities`, `llm_roadmap`. Их ручные изменения могут не попасть в публикацию.

**Решение:** сохранять полный versioned `client_insights` contract и проводить schema validation перед publish/export.

### P1: Preview и publication могут расходиться

UI умеет переключать analyst/client preview, но publish payload не содержит явного `view_mode`. Выбранный preview не является гарантией режима публичной ссылки.

**Решение:** добавить `view_mode` в publish contract; default для клиентской ссылки — `client`.

### P1: Нет traceability от рекомендации до результата

Текущие tasks и opportunity-like modules не образуют стабильный lifecycle. Рекомендация не обязана иметь stable ID, owner, expected metric, due date, linked task и after-check.

**Решение:** добавить `project_growth_opportunities` и связать его с `tasks_auto_log`, SEO tasks, content tasks, meta tasks, link tasks и последующими snapshots.

## Оценка клиентской ценности

| Слой | Сейчас | Целевое состояние |
|---|---|---|
| Ответ на «что изменилось?» | KPI и графики, AI summary ниже по странице | Executive headline с verified facts и периодом |
| Ответ на «почему?» | Частично AI-гипотезы, не всегда evidence-linked | Fact/hypothesis separation with source refs |
| Ответ на «где рост?» | Backend modules и action plan не полностью видны в Report | Top opportunities с URL/query and impact |
| Ответ на «что делать?» | Quick wins и tasks отдельными блоками | Action, owner, priority, due date and linked task |
| Ответ на «как измерить?» | Success metric не является обязательным полем | Before/after metric and measurement date |
| Доверие к данным | Global completeness + local empty/error states | Data confidence per report and per insight |
| Воспроизводимость | Live/snapshot есть, но связь с analysis model слабая | Immutable analysis/snapshot/projection version |

## Приоритетные показатели для клиента

Клиентский отчёт должен показывать не максимум сырых показателей, а минимальный набор, который помогает принять решение:

| Группа | Показатели |
|---|---|
| Result | Clicks, impressions, CTR, average position, visibility, Top-10 queries |
| Data quality | Source status, capture date, complete/partial, confidence |
| Growth potential | Striking distance, CTR gap, lost/potential clicks, content health, technical risk |
| Business interpretation | Traffic value only with clear source/method and no false revenue promise |
| Execution | Open opportunities, planned/in-progress/done tasks, measured effects |
| Next step | Top 3 actions, owner, horizon, success metric |

Google и Яндекс должны отображаться раздельно с явной подписью поисковой системы. Смешанная сумма допустима только для отдельных clearly-labeled business views, но не как универсальная «позиция сайта».

## Целевая модель

Projects должен быть источником анализа и snapshot. Reports должен быть клиентской проекцией normalized analysis. SEO/content tasks должны принимать opportunity contract, а следующий analysis должен измерять эффект той же opportunity.

```text
Project configuration
  → source collection
  → snapshot + freshness + completeness
  → deterministic analysis layers
  → normalized growth opportunities
  → priority/action plan
  → linked SEO/content/tasks
  → next-period measurement
  → client/analyst/export projections
```

Подробные таблицы, migrations, API, durable jobs, schema, UI и acceptance criteria находятся в:

`TECHNICAL_TASK_PROJECTS_REPORTS_UNIFIED_GROWTH_PIPELINE.md`

## Итоговый вывод

Система уже имеет достаточную глубину аналитических модулей, чтобы стать сильным SEO decision platform. Основное усиление должно быть не в добавлении ещё одного AI-отчёта, а в **связывании уже собранных данных в проверяемый feedback loop**.

Первый этап должен устранить P0: durable jobs, analysis-to-report linkage, opportunity normalizer и client Growth Overview. Второй этап должен добавить evidence/provenance, task linkage, effect measurement и отдельные client/analyst projections. Только после этого имеет смысл расширять дополнительные AI-выводы: LLM должен объяснять уже выбранные и доказанные возможности, а не самостоятельно определять реальность проекта.

## Исследованные runtime-файлы

- `backend/src/controllers/projects.controller.js`
- `backend/src/controllers/reports.controller.js`
- `backend/src/services/projects/analysisRunner.js`
- `backend/src/services/projects/sourceComparison.js`
- `backend/src/services/reports/dataAggregator.js`
- `backend/src/services/reports/reportModulesService.js`
- `backend/src/services/reports/aiAnalyst.js`
- `backend/src/services/reports/viewModeSanitizer.js`
- `frontend/src/views/ProjectDetailPage.vue`
- `frontend/src/views/ReportEditorPage.vue`
- `frontend/src/views/ProjectsPage.vue`
- `frontend/src/views/ReportsPage.vue`
- `frontend/src/components/reports/ReportRenderer.vue`
- `frontend/src/stores/reports.js`

