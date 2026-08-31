# Техническое задание
## Надёжная генерация SEO-текста по ТЗ: аудит pipeline, контроль качества и безопасное применение PromptSculptor v0.4

**Статус:** проект ТЗ, код не изменяется и не публикуется до отдельного подтверждения.

**Дата анализа:** 31 августа 2026 года.

**Основание:** полный приложенный лог задачи «Лечение гормонального фона», текущая архитектура SEO-генератора и материалы `PromptSculptor v0.4`: спецификация, Starter Prompt и Help Guide.

**Главное ограничение:** не менять без отдельного согласования порядок генерационных этапов, ownership задач, сохранённые статьи, тарифы, RBAC, `.env`, БД, очереди и рабочие модели. Улучшения должны усиливать надёжность и управляемость уже существующего pipeline, а не сокращать качество или удалять этапы.

---

## 1. Цель работы

Необходимо сделать генерацию SEO-текста по техническому заданию предсказуемой по качеству, времени и стоимости. Pipeline должен корректно переживать частичные ошибки парсинга, таймауты внешних исследовательских агентов, превышение лимитов контекста, усечённые JSON-ответы, временные ошибки Gemini, разрыв SSE и исчерпание task budget.

Итоговая система должна выдавать не просто HTML, а **проверенный результат с честным статусом качества**. Если обязательный аудит не выполнен, это не должно отображаться как настоящий PQ `0`. Если часть источников недоступна, это должно быть отражено в evidence coverage. Если YMYL-контент не имеет подтверждённых фактов и экспертных источников, автоматическая публикация не должна считаться безопасной.

Целевые требования:

| Область | Целевое состояние |
|---|---|
| Завершение задачи | Нет зависания в неопределённом состоянии; каждая ошибка приводит к retry, fallback или понятному `partial/failed` |
| Время | Целевая генерация одного текста — до 45 минут; hard limit должен быть виден как техническое ограничение, а не достигаться случайным исчерпанием бюджета |
| Качество | Каждый блок имеет объективные метрики; PQ, LSI и E-E-A-T не подменяются нулём при недоступности аудита |
| E-E-A-T | Для YMYL-тем обязательны доказательства, источники, экспертные ограничения и маркировка неподтверждённых утверждений |
| LSI | Используются релевантные термины по блокам без насильственной инъекции и переспама |
| Стоимость | Фактические токены, cache-hit, retries и стоимость учитываются по уникальному API-вызову, а не по повторно проигранным SSE-событиям |
| Промпты | Статические критические промпты проходят PromptSculptor AUDIT; Level 3 не применяется автоматически |
| Сохранение | Лучший валидный результат не теряется при ошибке последующего аудита или refine |

---

## 2. Что фактически показал приложенный лог

Лог содержит 324 строки и, судя по повтору от Stage 0 после разрыва SSE, включает повторную выдачу исторических событий после reconnect. В нём видны два больших фрагмента одного pipeline: до и после строки `SSE: соединение прервано. Реконнект #1/3 через 3s...`.

По детерминированному разбору лога получены следующие показатели. Они характеризуют **видимую телеметрию файла**, а не окончательную фактическую стоимость: часть строк повторно проиграна после SSE reconnect, а лог обрывается во время Stage 7.

| Показатель | Наблюдение |
|---|---:|
| Строк в логе | 324 |
| Видимых записей со стоимостью | 50 |
| Сумма видимых стоимостей | `$3.559899`, использовать как точную стоимость нельзя |
| Видимая сумма до reconnect | `$0.983072` |
| Видимая сумма после reconnect/replay | `$2.576827`, содержит повторно показанные события и новые вызовы |
| Видимых длительностей API-вызовов | 59 |
| Сумма видимых длительностей | около 173 минут процессорного/API времени; это не wall-clock из-за `Promise.all` и concurrency |
| Самый длинный отдельный вызов | 545.5 секунды, около 9.1 минуты |
| Конкурентность аудита блоков | 3 блока одновременно |
| Блоков в статье | 7 |
| Критические `FAILED`/ошибочные события | 20 по широкому поиску лога |
| Truncated/обрезанные ответы | 16 совпадений, включая повторный replay |
| JSON parse failures | 12 совпадений по повторным и исходным сообщениям |
| Provider 503 | 2 случая |
| Ошибки загрузки страниц | 4 строки, две страницы повторяются после reconnect |
| Budget skip/exhausted | 6 событий |
| Pre-check/quality failures | 11 событий |

Лог не содержит полноценного финального результата Stage 7: последняя строка — `Stage 7: Глобальный аудит — промпт 34902 символов, HTML 24245 символов, LSI 429 слов, TF-IDF терминов 20...`. Поэтому по этому файлу нельзя подтвердить успешную финализацию, итоговый глобальный PQ, сохранение финального HTML и публикационную готовность.

---

## 3. Критические проблемы, которые остаются

### 3.1. Переполнение входного контекста на Stage 0

Зафиксировано:

```text
Stage 0 evidence budget: SERP 61540 chars; GIST 8 pages/47491 chars
Niche Landscape FAILED после 1 попыток: Input text too long
Stage 0 Call 2 error: Input text too long
```

Проблема не в единичном плохом сайте. В Stage 0 в один вызов попадает слишком большой объединённый evidence-пакет: SERP, GIST и очищенные страницы. Повторная попытка с тем же объёмом не имеет смысла и только создаёт ложное ощущение retry-механизма.

**Влияние:** стратегический Niche Landscape не выполняется; последующие этапы продолжают работу на неполном контексте; расход времени и токенов не контролируется.

**Требование:** перед каждым LLM-вызовом делать preflight token estimate и жёстко формировать бюджет контекста по источникам. При переполнении сначала выполнять детерминированное сжатие evidence с сохранением цепочек `claim → source → quote`, а не повторять полный запрос. Не допускать вызова, который уже превышает лимит.

### 3.2. Неполный и неоднородный сбор источников

Зафиксировано:

```text
Парсинг 20 страниц...
Спарсено 16/20 (вкл. наш сайт) (2 прочих ошибок)
404 — https://zdorovie-vn.ru/...
Request failed ... https://mynutriciolog.ru/...
```

Из 20 страниц четыре не дали полноценный материал, причём одна имеет явный HTTP 404, а вторая — неясную ошибку без диагностического кода. Fallback продолжает pipeline, что само по себе правильно, но сейчас не видно достаточного разделения между `source_unavailable`, `source_empty`, `source_blocked`, `source_http_error` и `source_parse_error`.

**Влияние:** уменьшается доказательная база, а модель может компенсировать пробелы общими фразами. Для медицинской YMYL-темы это влияет на E-E-A-T сильнее, чем для обычной коммерческой темы.

**Требование:** каждой странице присваивать структурированный статус, canonical URL, HTTP-код, размер очищенного текста, тип ошибки и пригодность для evidence. Сохранять список недоступных источников в task result. Не выдавать недоступный источник за подтверждение.

### 3.3. Qwen Research Agent регулярно теряет до 7 минут на timeout

Зафиксировано:

```text
Stage 0 Qwen Research Agent error: Qwen research API error: timeout of 420000ms exceeded
fallback на DeepSeek/Gemini
```

Для одного необязательного research-агента timeout 420 секунд слишком велик относительно общей цели 45 минут. При повторном replay эта строка показывается снова, но это не обязательно означает повторный реальный вызов.

**Влияние:** увеличивается latency; research не даёт результата; fallback работает поздно; пользователь видит много времени без полезного результата.

**Требование:** разделить `connect timeout`, `first-byte timeout`, `read timeout` и `hard deadline`. Для optional Qwen research установить отдельный короткий deadline, после которого сразу использовать уже собранный SERP/Node evidence. В лог писать `attempt_id`, `call_id`, `was_replayed`, `fallback_reason`.

### 3.4. Entity Landscape дважды обрывается по лимиту output

Зафиксировано:

```text
Entity Landscape truncated response (finishReason=length, maxTokens=16000)
Entity Landscape truncated response (finishReason=length, maxTokens=32000)
retry cap 32000 достигнут
```

Модель два раза не уложилась в заданный контракт. Увеличение `maxTokens` с 16 000 до 32 000 не решило проблему и привело к дорогому вызову около 465 секунд.

**Влияние:** часть knowledge graph может отсутствовать или быть оборвана; большой output увеличивает стоимость и последующий размер Stage 2 context; ошибка маскируется тем, что итоговые ключи JSON присутствуют.

**Требование:** заменить стратегию «увеличить maxTokens» на bounded structured output. Для Entity Landscape обязателен компактный JSON с лимитами на число сущностей, связей и LSI-кластеров. При truncated output выполнять одну отдельную repair-команду только для восстановления JSON-контракта, а не повторять весь аналитический промпт. Если repair не удался, сохранять валидную частичную карту со статусом `partial`.

### 3.5. Stage 2 Taxonomy постоянно упирается в лимит 80 000 символов

Зафиксировано:

```text
STAGE1_JSON = 107206 символов
промпт 122988 символов > лимит 80000
промпт 115167 символов > лимит 80000
Применяю компакцию tier=1, затем tier=2
итоговый промпт 73709 символов
```

Текущая компакция происходит уже после формирования переполненного промпта. Кроме того, в логе указано `drop большие массивы / knowledge_graph / non-core поля`, но не видно отчёта о том, какие зависимости сохранены и какие потеряны.

**Влияние:** риск потери связей между сущностью, фактом, интентом и требованием; непредсказуемое качество taxonomy; большой prompt overhead остаётся.

**Требование:** строить bounded Context IR до сборки user prompt. Для каждого фрагмента хранить `priority`, `source_id`, `depends_on`, `must_retain`. Компакция должна быть dependency-closed: нельзя оставить вывод без факта, термин без определения или исключение без правила. В результате сохранять `context_manifest` с retained/dropped items и reason.

### 3.6. Semantic LSI Routing не выполняет JSON-контракт

Зафиксировано:

```text
2.5 Semantic LSI Routing truncated response ...
FAILED после 2 попыток: JSON parse failed after autoCloseJSON
fallback to JS routing
```

Fallback позволил продолжить работу, но это означает, что заявленный semantic routing через DeepSeek не был применён. При этом финальный лог пишет `семантический LSI/n-gram роутинг выполнен`, что слишком оптимистично: фактически выполнен fallback JS routing.

**Требование:** хранить `routing_method = deepseek | js_fallback`, `routing_status`, `fallback_reason`. Не называть fallback полноценным semantic routing. Для LSI routing сделать малый output-контракт: только массив `term → block_id → intent → priority`, без длинных объяснений. Валидировать JSON Schema до передачи результата в writer.

### 3.7. BRANDCORE/TGA сообщает `needs_human_review`, но pipeline продолжает как обычно

Зафиксировано:

```text
BRANDCORE/TGA: needs_human_review; facts=0, claims=0
```

Для медицинской темы отсутствие фактов и claims — критичный сигнал. Одновременно дальше формируется `E-E-A-T contract: 23 evidence, 36 entities, 0 LSI, risk=ymyl`. Это показывает, что evidence/claims из разных источников не сведены в единый gating-статус.

**Требование:** разделить:

| Состояние | Разрешённое поведение |
|---|---|
| `facts=0, claims=0`, YMYL | Не публиковать автоматически; продолжить только как `needs_human_review` |
| Evidence есть, но нет brand claims | Можно писать информационный материал, но запрещать утверждения от имени клиники |
| Есть claims без source | Заблокировать claim или пометить как unsupported |
| Evidence conflict | Сохранить конфликт и отправить на review |

Для медицинского контента нужно отдельно проверять, не превращает ли модель информационное описание в обещание лечения, гарантированный результат или индивидуальную рекомендацию.

### 3.8. E-E-A-T block audit часто обрывается или не парсится

Зафиксировано несколько повторяющихся цепочек:

```text
4 E-E-A-T Block ... truncated response
JSON parse failed after autoCloseJSON
audit_unavailable
Re-audit ... truncated response
Re-audit ... FAILED
```

Для блока 1 аудит недоступен, затем повторный аудит также недоступен. Pipeline продолжает с лучшим HTML, но это должно быть отражено в итоговом качестве.

**Влияние:** PQ и E-E-A-T для части блоков не измерены; дальнейший refine запускается на неполной диагностике; качество может выглядеть хуже или лучше реального.

**Требование:** E-E-A-T auditor должен возвращать маленький фиксированный JSON. Поля вроде `actionable_next_steps` и `recommended_material` не должны раздувать output на каждом блоке. Для каждого блока хранить:

```json
{
  "audit_status": "measured|unavailable|partial",
  "pq_score": null,
  "eeat_score": null,
  "deterministic_metrics": {},
  "llm_metrics": {},
  "issues": [],
  "source_call_id": "..."
}
```

`audit_unavailable` никогда не должен преобразовываться в `PQ = 0`.

### 3.9. Writer имеет массовые pre-check failures и дорогие повторные генерации

В логе зафиксированы повторы:

- блок 1: тавтология;
- блок 2: 5 повторов основы;
- блок 3: длинные абзацы более 500 символов;
- блок 4: 3 повтора основы;
- блоки 5–6: тавтологии;
- блоки 3, 5 и 6: превышение индивидуального лимита символов.

Retry часто создаёт новую полноценную генерацию блока, вместо того чтобы дать модели компактный список конкретных нарушений и требуемый patch.

**Требование:** перед retry формировать `repair_spec`:

```json
{
  "block_id": "block_2",
  "preserve": ["факты", "ссылки", "структуру H3"],
  "remove": ["повтор основы: гормональный фон"],
  "limits": {"max_chars": 4200, "max_paragraph_chars": 500},
  "must_keep_html_contract": true
}
```

Retry должен быть targeted rewrite, а не повторным свободным сочинением. После repair нужно повторно проверить только затронутые метрики и затем общий HTML contract.

### 3.10. PQ `0` у блока 1 не является реальной оценкой качества

Зафиксировано:

```text
Stage 5 блок 1: рефайн итерация 1/3 (PQ 0 < 7.5; naturalness issues)
...
Stage 5 блок 1: PQ 0 после 1 итераций — продолжаем с лучшим результатом
```

Ранее для блока был `audit_unavailable`. Поэтому `0` — техническое значение «нет оценки», но pipeline использует его как настоящий низкий PQ и запускает лишний refine.

**Требование:** использовать `null` для отсутствующего PQ и отдельный `quality_status`. Правило refine:

```text
if pq_score is measured and pq_score < target → refine;
if pq_score is unavailable → targeted naturalness/structural checks only;
if audit is failed → one bounded audit repair, then partial status.
```

### 3.11. LSI не достигает цели для части блоков

Итоговые значения:

| Блок | LSI | PQ | Наблюдение |
|---:|---:|---:|---|
| 1 | 76% | unavailable/0 | инъекция выполнена, но цикл не поднял покрытие до 80% |
| 2 | 100% | 7 | формально достигнуто, но `spam_risk: true` |
| 3 | 89% | 9 | покрытие достигнуто, но был лимит символов |
| 4 | 92% | 6 | PQ ниже цели, после retry остался 6 |
| 5 | 98% | 9.5 | осталась вода-фраза «Оптимальное решение» |
| 6 | 85% | 9.5 | покрытие достигнуто |
| 7 | 24% | 7 | LSI injection пропущена из-за budget skip |

Среднее арифметическое этих семи процентов — около 80.6%, но это не означает, что статья соответствует цели: блок 7 имеет 24%, а блок 2 имеет `spam_risk: true`.

**Требование:** считать не только среднее, но и minimum block coverage, weighted coverage по интенту, overdose risk и coverage по обязательным терминам. Нельзя искусственно добивать LSI в FAQ или коротком блоке, если это ухудшит естественность. Каждая блоковая цель должна зависеть от роли блока.

### 3.12. Исчерпание task token budget перед последним блоком

Критичная строка:

```text
Block 7 FAILED ... gemini token budget exhausted:
188226/200000 input tokens reserved
Skip non-essential calls (Stage 6 cycle, Stage 5 retries) and continue
```

Это означает, что к началу FAQ-блока уже зарезервировано 188 226 из 200 000 input-токенов. Последний блок получает только fallback, а Stage 5/6 для него пропускаются.

**Влияние:** итоговая статья формально продолжается, но качество неравномерно; расход почти достигнут до завершения; дополнительные изображения/аудиты и финальная проверка могут не выполниться.

**Требование:** ввести budget reserve. До запуска каждого блока резервировать:

```text
writer_reserve
+ audit_reserve
+ one_repair_reserve
+ finalization_reserve
```

Если бюджет не позволяет завершить блок и его обязательный аудит, система должна не запускать свободную генерацию, а перейти к bounded fallback или завершить задачу как `partial_budget_exhausted`. Нельзя расходовать весь бюджет на первые блоки.

### 3.13. Stage 6 LSI injection иногда отклоняется собственными лимитами

Зафиксировано:

```text
LSI Inject Block 1 cycle 1 ...
цикл ОТКЛОНЁН — HTML 4600 символов > лимит 4418
```

Инъекция увеличила HTML выше допустимого лимита, поэтому результат отвергнут. Это показывает, что prompt не получает точный размер свободного пространства и не умеет сокращать локальный текст одновременно с добавлением терминов.

**Требование:** перед LSI repair передавать `available_char_budget`, список конкретных допустимых мест вставки и запрет на увеличение блока. Если термин нельзя вставить естественно в лимит, оставить его невставленным и отметить `not_inserted_reason`, а не запускать бессмысленную генерацию.

### 3.14. Разрыв SSE и повторная выдача событий искажает наблюдаемую стоимость

Лог после `SSE: соединение прервано` повторяет начало pipeline и стоимости. Без `event_id`/`call_id` невозможно отличить:

- реальный повтор API-вызова;
- повторную выдачу сохранённых событий;
- новый retry;
- reconnect клиента.

**Требование:** каждое событие и API-вызов должны иметь:

```text
run_id
stage_id
block_id
call_id
attempt
event_id
created_at
replayed
provider
model
input_tokens
cached_input_tokens
output_tokens
cost_usd
latency_ms
```

UI может показывать replay-события, но аналитический агрегатор стоимости обязан считать только уникальные `call_id`.

### 3.15. Глобальный аудит не завершён в приложенном файле

Лог обрывается на запуске Stage 7. Поэтому неизвестны финальные:

- global PQ;
- финальный E-E-A-T score;
- финальный LSI/TF-IDF verdict;
- факт сохранения HTML;
- факт сохранения JSON;
- факт завершения task;
- ошибки финального cleanup.

**Требование:** финализатор обязан сохранять `finalization_manifest` даже при частичном результате:

```json
{
  "task_status": "done|partial|failed",
  "html_saved": true,
  "json_saved": true,
  "global_audit_status": "measured|unavailable",
  "quality_is_publishable": false,
  "degraded_reasons": ["..."],
  "completed_stages": ["..."],
  "failed_stages": ["..."]
}
```

---

## 4. Сводный приоритет исправлений

| Приоритет | Задача | Почему первой |
|---|---|---|
| P0 | Budget reserve и preflight token accounting | Сейчас бюджет исчерпывается до блока 7 и обязательных аудитов |
| P0 | Малые JSON-контракты для Entity/LSI/E-E-A-T | Truncated и parse failures блокируют измерение качества |
| P0 | Разделить `unavailable` и score `0` | Иначе система принимает неверные решения по refine и PQ |
| P0 | Финальный manifest и честные `done/partial/failed` | Лог обрывается без доказательства финализации |
| P1 | Context IR с dependency closure | Stage 0/2 постоянно переполняют prompt и теряют контекст при tier compaction |
| P1 | Идемпотентная SSE-телеметрия | Нельзя честно считать стоимость и ретраи из текущего лога |
| P1 | Targeted repair для writer/pre-check | Массовые повторные генерации создают время и стоимость без стабильного исправления |
| P1 | Source status/evidence registry | 16/20 страниц недостаточно описаны для YMYL-контента |
| P1 | YMYL/BRANDCORE hard gate | `facts=0, claims=0` нельзя пропускать как обычное состояние |
| P2 | Адаптивная concurrency и circuit breaker для Gemini | Два HTTP 503 показывают перегрузку при параллельной работе |
| P2 | PromptSculptor AUDIT static prompts | Сначала нужно стабилизировать контракты, затем сжимать промпты |
| P2 | Per-block LSI policy | Среднее покрытие скрывает блок с 24% и блок со spam risk |
| P2 | Улучшение визуальной и пользовательской телеметрии | Пользователь должен видеть «partial audit», а не ложный PQ 0 |

---

## 5. Архитектура целевого pipeline без удаления этапов

```text
Input ТЗ и проект
      ↓
Preflight: лимиты, ownership, бюджет, модель, deadline
      ↓
Source Registry: URL → status → cleaned content → evidence quality
      ↓
Evidence Budgeter: capped evidence + dependency manifest
      ↓
Stage 0: niche / opportunity / demand с bounded context
      ↓
Stage 1: entities / intents / community в малом JSON-контракте
      ↓
Stage 2: buyer journey / format / taxonomy с Context IR
      ↓
Stage 2.5: semantic LSI routing → DeepSeek или явный JS fallback
      ↓
IAKB: полный контекст сохраняется, call-time slices ограничены
      ↓
Stage 3: writer по блокам с output budget и block contract
      ↓
Deterministic pre-check: HTML, абзацы, списки, повторения, лимиты
      ↓
Stage 4/5: E-E-A-T/PQ audit → measured / partial / unavailable
      ↓
Targeted repair: только конкретные нарушения и один bounded retry
      ↓
Stage 6: LSI injection только в доступный char budget
      ↓
Global audit: компактный JSON, deterministic metrics authoritative
      ↓
Finalization manifest: done / partial / failed + сохранение всех артефактов
```

Ни один fallback не должен скрываться под названием успешного основного этапа. Например, `JS fallback` должен отображаться как `routing_method=js_fallback`, а `audit_unavailable` — как отсутствие оценки, не как PQ `0`.

---

## 6. Требования к PromptSculptor v0.4

### 6.1. Границы применения

PromptSculptor применять прежде всего к **статическим system/developer-промптам**, а не к динамическому evidence-контексту статьи. Динамический контекст сжимается отдельным Context/RAG Budgeter с сохранением dependency closure.

Критичные промпты Stage 0, Stage 1, Stage 2, Stage 2.5, writer, E-E-A-T и global audit должны проходить отдельный `AUDIT` после каждой кандидатной компрессии. До получения `PASS` или обоснованного `PASS_WITH_WARNINGS` кандидат нельзя считать готовым к production.

### 6.2. Уровни

| Уровень | Применение |
|---|---|
| Level 1 Guarded | Для system/developer-промптов writer, audit и safety; только нормализация/дедупликация |
| Level 2 Balanced | Для аналитических промптов при сохранении всех условий, исключений, JSON keys и примеров |
| Level 3 Aggressive | Только для некритичных пояснений и только с явным `removable_preferences`; по умолчанию запрещён |

PromptSculptor должен сохранить исходные message roles и их порядок. Нельзя превращать system/developer/user/tool в единый плоский prompt.

### 6.3. Обязательный structured input

Для интеграционного вызова использовать `output_format: json`, даже если операторский режим по умолчанию возвращает Markdown. Обязательные поля:

```json
{
  "mode": "COMPRESS|AUDIT",
  "requested_level": 1,
  "output_mode": "full",
  "output_format": "json",
  "source_messages": [],
  "candidate_messages": [],
  "target_model": "...",
  "tokenization": {
    "status": "EXACT|ESTIMATED|UNAVAILABLE",
    "tokenizer_id": "...",
    "source_tokens": null,
    "candidate_tokens": null
  },
  "target_token_budget": null,
  "cost_policy": {
    "input_token_cost": null,
    "cached_input_token_cost": null,
    "output_token_cost": null,
    "max_output_growth_ratio": null,
    "on_unknown_pricing": "RISK_ONLY"
  },
  "removable_preferences": [],
  "test_cases": [],
  "execution_results": null
}
```

### 6.4. Protected literals

Нельзя изменять при компрессии:

- имена моделей и адаптеров;
- JSON keys и enum values;
- лимиты токенов/символов;
- thresholds PQ/LSI/E-E-A-T;
- retry caps и timeout values;
- `must`, `only`, `never`, `unless`, `before`, `after` и другие условия;
- названия стадий и порядок pipeline;
- tool permissions, safety rules и правила YMYL;
- имена функций, путей и переменных, если они присутствуют в исполняемом контракте.

### 6.5. Test cases и measured audit

Для каждого критичного prompt template подготовить до трёх representative test cases:

1. обычная информационная тема;
2. YMYL-тема с отсутствующими фактами;
3. переполненный evidence-контекст или недоступный источник.

Сначала выполнить статический `AUDIT` с forward/reverse trace. После этого выполнить baseline/candidate на одинаковых тестах и передать `execution_results`. Нельзя называть экономию токенов измеренной без фактических tokenizer/cost/execution данных.

---

## 7. Требования к контексту и токенам

### 7.1. Per-stage budgets

Для каждой стадии задать отдельные лимиты:

| Слой | Что ограничивается |
|---|---|
| Source fetch | число URL, размер HTML, размер cleaned text |
| SERP/GIST evidence | страницы, символы, цитаты, дубликаты |
| Stage 0 | отдельные бюджеты SERP, GIST, competitor snippets, internal context |
| Stage 1 | число entities, relations, clusters, questions |
| Stage 2 | buyer journey, formats, taxonomy, routing context |
| Writer | system prompt, call-time AKB, block context, HTML output |
| Block audit | только block HTML + компактные requirements, без полного AKB |
| Final audit | итоговый HTML, агрегированные metrics и evidence digest |

### 7.2. Reserve formula

Перед стартом должна быть вычислена минимальная резервация:

```text
available_budget = task_input_budget - already_reserved
required_reserve =
    remaining_writer_calls
  + mandatory_audits
  + one_repair_per_failed_block
  + final_global_audit
  + finalization_margin
```

Если `available_budget < required_reserve`, система должна уменьшить контекст и число optional calls, но не скрыто пропускать обязательный audit.

### 7.3. Не допускать ложной экономии

Уменьшение input prompt не является улучшением, если из-за него выросли output tokens, retries, parse failures или потерялись требования. PromptSculptor должен использовать Cost-Aware Governor: при высокой неопределённости Level 3 автоматически понижается до Level 2, а при нарушении hard requirement кандидат отклоняется.

---

## 8. Требования к retry, fallback и провайдерам

Каждый API-вызов должен иметь ограниченный budget и тип ошибки. Retry разрешён только если причина retryable:

| Ошибка | Поведение |
|---|---|
| HTTP 429/503 | exponential backoff + ограниченный retry + уменьшение concurrency при серии ошибок |
| timeout optional agent | быстрый fallback, не занимать общий hard deadline |
| input too long | не повторять тот же prompt; compact context и повторить один раз |
| truncated JSON | bounded repair JSON; не удваивать полный output budget бесконечно |
| JSON parse error | repair только если есть recoverable partial; затем `audit_unavailable/partial` |
| HTTP 404 страницы | пометить источник unavailable и продолжить evidence registry |
| budget exhausted | остановить optional calls; сохранить лучший результат и `partial_budget_exhausted` |
| SSE disconnect | reconnect без повторного API-вызова; события должны быть idempotent |

Для Gemini 503 нужна адаптивная concurrency: при двух и более 503 в коротком окне concurrency снижается с 3 до 2 или 1, а после периода стабильности постепенно возвращается.

---

## 9. Требования к качеству контента

### 9.1. Deterministic metrics

Детерминированные проверки должны быть авторитетными для структурных признаков:

- HTML contract;
- H1/H2/H3 hierarchy;
- длина блока и абзацев;
- наличие списков/таблиц;
- повторы и тавтологии;
- ссылки и URL;
- LSI coverage;
- BM25/TF-IDF coverage;
- запрещённые или неподтверждённые claims.

LLM-аудит может объяснять проблему и предлагать repair, но не должен молча переопределять детерминированный показатель. При расхождении хранить оба значения: `deterministic_value` и `llm_value`.

### 9.2. E-E-A-T/YMYL gate

Для медицинской темы перед финализацией проверять:

- источник каждого фактического утверждения;
- отсутствие обещаний гарантированного результата;
- отсутствие индивидуального диагноза и назначения лечения;
- корректное описание специалистов, протоколов и безопасности только при наличии evidence;
- явное различие между общей информацией и коммерческим claim клиники;
- статус `needs_human_review` при отсутствии фактов/claims.

Нулевая evidence-база не должна компенсироваться уверенным тоном модели.

### 9.3. PQ и LSI

Цель `PQ ≥ 7.5` должна применяться только к измеренному PQ. Для unavailable нужен `null`, а итоговый статус должен быть `quality_unmeasured` или `partial`.

LSI следует оценивать минимум по четырём измерениям:

```text
weighted_coverage
minimum_block_coverage
mandatory_term_coverage
overuse_or_spam_risk
```

Если блок FAQ естественно не требует всех терминов, его цель может быть ниже, но это должно быть задано policy, а не появляться как случайный провал.

---

## 9A. Отдельный аудит расчёта E-E-A-T / PQ

### 9A.1. Важное разграничение терминов

Внутренний показатель генератора нельзя называть официальным «Google PQ score». Google описывает E-E-A-T как набор признаков для оценки полезности и надёжности контента, но отдельно указывает, что E-E-A-T сам по себе не является конкретным ranking factor, а оценки quality raters не передаются напрямую в алгоритм ранжирования. Поэтому наш показатель должен называться **внутренний E-E-A-T/PQ score для контроля качества**, а не обещать прямое соответствие оценке поисковой системы [5] [6].

В текущем коде одновременно существуют минимум четыре разных модели, которые могут восприниматься как один показатель:

| Источник | Текущая шкала и метод | Риск смешения |
|---|---|---|
| `qualityLayers/qualityScore.js` | composite `overall` 0–100; E-E-A-T получает вес 0.28, вместе с readability, fact-check, plagiarism, intent, LSI, image QA и validation | Это общий Content Quality Score, а не чистый E-E-A-T |
| `eeatAudit/contentContract.js` | 12 компонентов по 0–10; сейчас равное среднее `sum(components)/12` | Это отдельный heuristic E-E-A-T contract score |
| `pipeline/stage7.js` | среднее только 5 полей: experience, expertise, authoritativeness, trustworthiness, content_quality; fallback на `page_quality_score` | 5 критериев и PQ подменяют 12 критериев E-E-A-T |
| `qualityLayers/eeatChunker.js` | weighted-by-plainChars среднее только `pq_score`, `evidence_quality`, `freshness_signals`, `style_consistency` | Block aggregate не совпадает с article aggregate |

**Требование:** в следующей реализации выбрать один canonical `eeat_score_12` по 12 критериям и отдельно хранить `content_quality_score`. Эти величины нельзя смешивать в одной карточке как будто это одно измерение.

### 9A.2. Фактическая текущая формула composite quality score

В `qualityLayers/qualityScore.js` текущие веса такие:

```text
eeat         0.28
readability  0.15
fact_check   0.18
plagiarism   0.12
intent       0.07
lsi          0.13
image_qa     0.04
validation   0.03
```

Сумма весов равна 1.0. Каждая доступная субметрика приводится к 0–100. Отсутствующие поля или `verdict=na` исключаются, после чего оставшиеся веса перераспределяются:

```text
overall = sum(weight_i * score_i) / sum(weight_i for available_i)
```

Это математически корректное взвешенное среднее, но методологически опасное поведение: если отсутствует E-E-A-T audit, его вес 0.28 распределяется на остальные показатели, и общий score может остаться высоким при отсутствии главной оценки доверия. Поэтому редистрибуция должна быть разрешена только для необязательных метрик и обязательно сопровождаться `coverage_ratio` и `score_status=partial`.

Дополнительные проблемы текущего composite score:

1. `verdict → score` использует грубую шкалу `pass=100`, `review=65`, `refine=50`, `mismatch=30`, `fail=10`. Эти значения нельзя считать калиброванными без набора размеченных материалов.
2. `readability` при неизвестном verdict получает fallback 60, что превращает отсутствие результата в числовую оценку.
3. LSI score берёт coverage и вычитает штраф за overdose, но не учитывает семантическую уместность и не должен определять E-E-A-T.
4. Image QA и validation влияют на общий Content Quality Score, но не являются самостоятельными E-E-A-T критериями.
5. Общий score округляется до одного знака, а отдельные компоненты и источники могут иметь другую точность.

### 9A.3. Фактическая текущая 12-критериальная модель

В `eeatAudit/contentContract.js` задекларированы 12 метрик:

| Критерий | Что должен измерять | Что нельзя делать |
|---|---|---|
| `experience` | подтверждённый first-hand опыт или реальный опыт бренда | ставить 7 по умолчанию только потому, что тема low-risk |
| `expertise` | глубина предметного объяснения и компетентность | считать количество entities достаточным доказательством экспертизы |
| `author_transparency` | реальный автор, роль, профиль и прозрачность авторства | считать «Редакция» полноценным автором для YMYL |
| `reviewer_validation` | подтверждённый reviewer и его роль | ставить 8 для low-risk без отметки N/A |
| `factual_accuracy` | подтверждённость фактов, чисел и claims | считать наличие любого evidence доказательством всех claims |
| `source_transparency` | качество, полнота и видимость источников | считать одну ссылку достаточной для всей статьи |
| `entity_completeness` | раскрытие обязательных сущностей и связей | использовать только количество entities без relevance/evidence |
| `information_gain` | оригинальная полезная дельта относительно источников и SERP | приравнивать таблицу к доказанной уникальности |
| `specificity_actionability` | конкретные шаги, условия и ограничения | награждать общие советы за наличие слова «рекомендация» |
| `trustworthiness` | отсутствие неподтверждённых обещаний, конфликтов и опасных claims | компенсировать риск красивой стилистикой |
| `intent_fit` | соответствие поисковому и пользовательскому интенту | оценивать только по наличию ключевой фразы |
| `freshness_editorial_ux` | актуальность, структура, дата и удобство чтения | считать текущий год доказательством свежести фактов |

Сейчас `metricScores()` содержит эвристики наличия. Например, `factual_accuracy` получает 8 при наличии evidence и 3 при наличии unsupported claims, а `reviewer_validation` получает 8 для low-risk темы даже без reviewer. Это годится как предварительный deterministic baseline, но не как окончательно калиброванный PQ.

**Требование:** каждое значение должно иметь `score_status`, `method`, `evidence_ids`, `confidence` и `reason`. Если критерий не применим, нужно использовать `not_applicable`, а не искусственное число. Если критерий нельзя измерить, нужно использовать `unavailable`, а не 0, 3, 6 или 7.

### 9A.4. Единая целевая формула E-E-A-T 12

Рекомендуемая canonical модель — 12 критериев по шкале 0–10 с версионированными весами:

```text
experience             0.08
expertise              0.09
author_transparency    0.06
reviewer_validation    0.07
factual_accuracy       0.16
source_transparency    0.14
entity_completeness    0.05
information_gain       0.10
specificity_actionability 0.08
trustworthiness        0.10
intent_fit             0.04
freshness_editorial_ux 0.03
TOTAL                  1.00
```

Для применимых и измеренных критериев:

```text
eeat_score_12 =
  10 × sum(weight_i × applicability_i × measured_score_i)
      / sum(weight_i × applicability_i)
```

Где `measured_score_i` находится в 0–10, а `applicability_i` равен 1 для применимого критерия и 0 для честного `not_applicable`. `unavailable` не должен получать applicability=0 и одновременно выдавать полноценный итог без штрафа: при недоступности критически важного критерия итоговый статус обязан стать `partial`.

Для полной оценки нужны:

```json
{
  "score_version": "eeat12.v2",
  "scale": "0_10",
  "score": 7.8,
  "status": "measured|partial|unavailable|human_review",
  "coverage": 0.92,
  "criteria_measured": 11,
  "criteria_total": 12,
  "components": {
    "factual_accuracy": {
      "score": 8.4,
      "status": "measured",
      "method": "deterministic_plus_llm_audit",
      "confidence": 0.87,
      "evidence_ids": ["ev-research-1", "ev-brand-1"],
      "reason": "..."
    }
  },
  "hard_gates": {
    "passed": false,
    "blockers": ["reviewer_required_for_ymyl"]
  }
}
```

Округление разрешено только на финальном выводе. Для расчёта и агрегирования следует сохранять минимум две десятичные позиции.

### 9A.5. Hard gates отдельно от числового score

Числовой score не должен отменять обязательные блокеры. Для YMYL/медицины публикация запрещается при любом из условий:

| Условие | Требуемый результат |
|---|---|
| `factual_accuracy < 6.0` | `publishable=false`, blocker |
| `source_transparency < 6.0` | `publishable=false`, blocker |
| `trustworthiness < 6.0` | `publishable=false`, blocker |
| отсутствует reviewer, если policy его требует | `human_review` |
| есть unsupported critical claim | blocker до удаления или подтверждения |
| semantic/fact-check недоступен для YMYL | `human_review` или `partial`, не обычный `done` |
| global audit не завершён | нельзя выдавать `publishable=true` |
| budget exhausted до обязательных аудитов | `partial_budget_exhausted` |

Для обычной low-risk темы reviewer может быть `not_applicable`, но это должно отображаться в breakdown. Нельзя ставить ему 8 и создавать видимость полного прохождения критерия.

Важно разделить три результата:

```text
E-E-A-T score — числовая оценка доверия/экспертности 0–10.
Content quality score — composite quality 0–100 с LSI, readability и validation.
Publish gate — отдельное решение can_publish=true/false.
```

Статья с E-E-A-T 8.1, но без обязательного reviewer для YMYL, должна оставаться `human_review`, а не автоматически публиковаться.

### 9A.6. Агрегация блоков и защита от маскировки проблем

Текущее взвешивание `aggregateEeatVerdicts()` по `plainChars` полезно для больших статей, но не должно быть единственным способом агрегации. Большой блок не может полностью скрыть провал в коротком, но критичном FAQ, disclosure, disclaimer или byline.

Целевая агрегация:

```text
article_score = 0.70 × weighted_mean_by_relevant_chars
              + 0.30 × mean_of_critical_block_scores
```

При этом:

- критичные блоки определяются policy: intro/answer, methodology, evidence, limitations, FAQ, author/reviewer;
- пустые блоки не участвуют в среднем, но формируют structural warning;
- если любой критичный блок имеет `factual_accuracy < 6` или `trustworthiness < 6`, publish gate блокируется независимо от среднего;
- если часть блоков `unavailable`, итоговый status становится `partial`;
- weighted mean не должен считать неизвестный score равным нулю или минимальным числом;
- chunked audit должен возвращать `per_block`, `weighted_score`, `critical_floor`, `coverage` и `aggregation_version`.

### 9A.7. Расхождение с quality gate

`qualityCore/qualityGate.runForTask()` сейчас при внутренней ошибке возвращает безопасно продолжающий вердикт с `canPublish=true`. Для технической устойчивости это не должно означать publishable для YMYL. Нужно разделить:

```text
pipeline_continue=true
publishable=false
quality_gate_status=error
```

Ошибку quality gate можно проглотить, чтобы не уронить генерацию, но нельзя превращать её в разрешение публикации. Для low-risk допускается `canPublish` по policy, для YMYL — fail-closed при недоступности обязательной проверки.

### 9A.8. Что должно отображаться в интерфейсе

Вместо одной неоднозначной строки `E-E-A-T 7.0` показывать:

```text
E-E-A-T: 7.8/10
Статус: частично измерен — 11/12 критериев
Критический gate: ручная проверка обязательна
Content Quality: 82/100
LSI: 85% по 6 из 7 блоков
```

Если score недоступен:

```text
E-E-A-T: n/a
Причина: аудит блока 1 не завершён
```

Запрещено показывать `0.0` как замену отсутствующей оценки. В админской аналитике нужно отдельно считать `measured_count`, `partial_count`, `unavailable_count` и среднее только по измеренным значениям. Среднее `AVG(eeat_score)` без coverage создаёт ложную картину качества.

### 9A.9. Приёмочные тесты для PQ/E-E-A-T

Перед внедрением обязательны следующие тесты:

| Тест | Ожидаемый результат |
|---|---|
| Все 12 критериев измерены | canonical score 0–10, coverage=1, status=measured |
| Один необязательный критерий N/A | score пересчитан по applicable weights, N/A виден в breakdown |
| Один критичный критерий unavailable | score status=partial, не подставляется 0 и нет publishable |
| Все аудиты unavailable | `score=null`, `status=unavailable`, не `PQ=0` |
| Unsupported medical claim | factual/trust gate fail, human review |
| Нет reviewer для YMYL | blocker независимо от среднего score |
| Короткий критичный блок с низким score | critical floor блокирует публикацию даже при высоком weighted mean |
| `audit_unavailable` после JSON parse failure | не запускается обычный refine как для реального PQ=0 |
| Stage 7 score и 12-criteria score расходятся | сохраняются оба с разными names/version, конфликт виден |
| Повтор SSE/reconnect | quality и cost не дублируются |
| Устаревший score version | результат помечен `legacy`, не смешивается с новой статистикой |
| Веса | сумма ровно 1.0, все score в диапазоне 0–10 |

### 9A.10. Рекомендуемый порядок исправления PQ

1. Сначала зафиксировать названия и разделить `eeat_score_12`, `content_quality_score` и `publish_gate`.
2. Затем ввести `null/status/coverage` для unavailable и запретить score `0` как техническую замену.
3. После этого заменить эвристики fallback на component-level evidence и confidence.
4. Затем стабилизировать block aggregation и critical floors.
5. После стабилизации сравнить baseline и новую формулу на историческом корпусе, не переписывая старые статьи.
6. Только после измерения калибровать веса и подключать PromptSculptor к static prompts.

## 10. Требования к телеметрии и итоговому JSON

### 10.1. Событие стадии

```json
{
  "run_id": "...",
  "stage": "stage_2_5",
  "block_id": null,
  "event_id": "...",
  "call_id": "...",
  "attempt": 1,
  "replayed": false,
  "status": "success|partial|fallback|failed|skipped",
  "provider": "deepseek",
  "model": "deepseek-v4-pro",
  "latency_ms": 0,
  "input_tokens": 0,
  "cached_input_tokens": 0,
  "output_tokens": 0,
  "cost_usd": null,
  "error_code": null
}
```

### 10.2. Итоговый task manifest

```json
{
  "task_status": "done|partial|failed",
  "content_status": "complete|fallback|partial",
  "publishable": false,
  "completed_stages": [],
  "failed_stages": [],
  "fallback_stages": [],
  "quality": {
    "pq_score": null,
    "pq_status": "measured|unavailable|partial",
    "eeat_score": null,
    "eeat_status": "measured|needs_human_review|unavailable|partial",
    "lsi_coverage": null,
    "lsi_status": "measured|partial|unavailable",
    "spam_risk": null
  },
  "budget": {
    "input_reserved": 0,
    "input_used": 0,
    "output_used": 0,
    "remaining": 0,
    "budget_exhausted": false
  },
  "evidence": {
    "requested_sources": 0,
    "usable_sources": 0,
    "failed_sources": 0,
    "facts": 0,
    "claims": 0
  },
  "degraded_reasons": []
}
```

---

## 11. План реализации по итерациям

### Итерация 1 — observability и корректность статусов

1. Добавить `run_id`, `call_id`, `attempt`, `event_id`, `replayed` во все LLM/SSE events.
2. Устранить двойной учёт cost/token при replay.
3. Разделить `score=0` и `score unavailable` во всех quality objects.
4. Добавить finalization manifest и статусы `done/partial/failed`.
5. Добавить regression на SSE reconnect, truncated JSON и budget exhaustion.

**Критерий выхода:** по replay-логу можно однозначно определить уникальные API-вызовы и фактическую причину каждого fallback.

### Итерация 2 — budget manager и контекст

1. Добавить preflight token estimate до каждого вызова.
2. Добавить per-stage budgets и reserve formula.
3. Реализовать Context IR с dependency closure.
4. Ограничить Stage 0 SERP/GIST evidence до безопасных budgets.
5. Сохранить manifest retained/dropped context.

**Критерий выхода:** ни один LLM-вызов не стартует с заведомо превышенным input context.

### Итерация 3 — устойчивые JSON-контракты

1. Сократить output-схемы Entity, LSI routing, E-E-A-T и global audit.
2. Ввести schema validation.
3. Реализовать один bounded repair для truncated/invalid JSON.
4. Хранить partial result вместо бесконечного увеличения `maxTokens`.

**Критерий выхода:** повторный полный вызов не используется только для исправления синтаксиса JSON.

### Итерация 4 — writer/pre-check/refine

1. Формировать `repair_spec` из детерминированных нарушений.
2. Передавать exact char budget и список запрещённых повторов.
3. Разделить structural repair, naturalness repair и LSI repair.
4. Не запускать refine при `PQ unavailable` как при настоящем `PQ=0`.
5. Ввести адаптивную concurrency при HTTP 503.

**Критерий выхода:** повтор улучшает конкретное нарушение и не увеличивает блок выше лимита.

### Итерация 5 — PromptSculptor integration

1. Собрать source messages для каждого критичного static prompt.
2. Запустить PromptSculptor COMPRESS Level 1/2.
3. Запустить AUDIT для каждого кандидата с protected literals и test cases.
4. Провести baseline/candidate execution measurements.
5. Ввести versioning prompt templates и rollback.

**Критерий выхода:** ни один compressed prompt не попадает в runtime без положительного AUDIT и regression.

### Итерация 6 — YMYL/E-E-A-T и acceptance gate

1. Сделать BRANDCORE/TGA `needs_human_review` обязательным gate для медицинских claims.
2. Ввести source-to-claim traceability.
3. Добавить global audit completion check.
4. Не маркировать статью publishable при missing global audit, missing facts или budget exhaustion.

**Критерий выхода:** система честно показывает, какие требования выполнены, а какие требуют ручной проверки.

---

## 12. Приёмочные тесты

### 12.1. Error-handling fixtures

| Сценарий | Ожидаемый результат |
|---|---|
| Stage 0 evidence превышает лимит | compact один раз, затем valid fallback; нет повторения идентичного oversized prompt |
| 404/empty/blocked source | source registry с типом ошибки; pipeline продолжает работу без фальшивого evidence |
| Qwen timeout | быстрый fallback по deadline; необязательный агент не блокирует задачу 420 секунд |
| Entity output truncated | bounded repair или partial entity graph; нет бесконечного роста maxTokens |
| LSI JSON invalid | `routing_method=js_fallback`, статус fallback явно сохранён |
| E-E-A-T unavailable | `pq_score=null`, не `0`; не запускается обычный PQ refine |
| Gemini 503 | backoff и снижение concurrency; задача не дублирует вызов без причины |
| SSE reconnect | исторические события replayed и не учитываются повторно в cost |
| Budget exhausted | сохраняется лучший HTML, task status `partial_budget_exhausted`, обязательный manifest |
| Global audit truncated | статья не получает `publishable=true` |

### 12.2. Quality acceptance

Для контрольного прогона по YMYL-теме:

- все семь блоков имеют финальный status;
- нет `Input text too long`;
- нет неразрешённого `JSON parse failed`;
- нет score `0`, если аудит не измерен;
- нет скрытого `budget_skip` без итогового degraded reason;
- minimum block LSI и weighted coverage соответствуют policy;
- `spam_risk` не игнорируется при LSI `100%`;
- каждое медицинское утверждение имеет evidence или помечено как unsupported;
- global audit завершён либо статья `partial` и непубликуема;
- финальный HTML и JSON сохранены;
- уникальные API-вызовы и стоимость измеряются по `call_id`;
- wall-clock укладывается в согласованный hard limit, а не только средняя сумма параллельных вызовов.

### 12.3. PromptSculptor acceptance

Для каждого static prompt:

1. source и candidate передаются как структурированные message objects;
2. роли и их порядок сохранены;
3. protected literals сохранены;
4. output contract исполняем;
5. conditions, exceptions, prohibitions и workflow не ослаблены;
6. dependency closure закрыт;
7. candidate не добавляет unsupported behavior;
8. `AUDIT` verdict — `PASS` или обоснованный `PASS_WITH_WARNINGS`;
9. Level 3 не применяется без явной авторизации removable preferences;
10. фактическая экономия указывается только при наличии execution results и cost policy.

---

## 13. Что не следует делать

Нельзя решать проблему простым увеличением `maxTokens`, потому что это уже дважды привело к дорогому output truncation и увеличению размера последующих контекстов.

Нельзя отключать E-E-A-T, LSI, Stage 5/6 или другие этапы ради достижения 45 минут. Нужно уменьшать лишний контекст, повторные свободные генерации, неэффективные audit outputs и необязательные calls.

Нельзя считать fallback полным успехом основного этапа. `fallback` — рабочий режим продолжения, но он должен отражаться в качестве и final manifest.

Нельзя автоматически публиковать медицинский материал при `BRANDCORE/TGA: needs_human_review; facts=0, claims=0`.

Нельзя сжимать промпты Level 3 до прохождения PromptSculptor AUDIT и execution regression.

Нельзя суммировать стоимость по строкам пользовательского SSE-лога без дедупликации `call_id`.

Нельзя изменять или перезаписывать уже сохранённые статьи при внедрении новых quality gates. Новая логика должна применяться к новым задачам, а старые результаты должны оставаться доступными.

---

## 14. Вывод

По приложенному логу генератор не падает полностью: он умеет продолжать работу через fallback и сохранять лучший HTML на отдельных этапах. Но pipeline пока нельзя назвать стабильным и полностью контролируемым. Основные проблемы — переполнение контекста, слишком большие JSON-ответы, длительные и малоэффективные retries, неверное представление `unavailable` как PQ `0`, исчерпание бюджета до последнего блока, отсутствие финального manifest и недостаточно точная телеметрия после SSE reconnect.

Наиболее безопасный порядок реализации: сначала исправить статусы, бюджет и наблюдаемость; затем стабилизировать JSON-контракты и контекст; после этого оптимизировать writer/refine; и только затем применять PromptSculptor к статическим промптам через COMPRESS → AUDIT → measured regression. Такой порядок усиливает качество без урезания этапности и без риска потерять требования исходных промптов.

---

## Источники анализа

1. Приложенный лог генерации: `pasted_content_4.txt`, 324 строки.
2. `PromptSculptor-v0.4.md`, спецификация компрессии, AUDIT, Context/RAG, Cost-Aware Governor и verification.
3. `PromptSculptor-v0.4-Starter-Prompt.md`, протокол структурированного вызова.
4. `PromptSculptor-v0.4-Help-Guide.md`, порядок боевого тестирования и интерпретация verdict/cost.
5. [Creating helpful, reliable, people-first content — Google Search Central](https://developers.google.com/search/docs/fundamentals/creating-helpful-content), разделы E-E-A-T, Who/How/Why и self-assessment.
6. [Our latest update to the quality rater guidelines: E-A-T gets an extra E for Experience — Google Search Central Blog](https://developers.google.com/search/blog/2022/12/google-raters-guidelines-e-e-a-t), пояснение о роли Experience и границах quality-rater guidance.
