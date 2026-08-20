# Аудит генератора контента: расход LLM, скорость и качество

**Репозиторий:** `krasuhod-lang/generator1`  
**Ветка:** `main`  
**Дата аудита:** 20 августа 2026 года  
**Автор:** Manus AI

## 1. Итоговое заключение

Генератор не содержит одной общей «бесконечной» петли, однако его стоимость складывается из нескольких независимых каскадов: аналитические DeepSeek-вызовы перед writer-стадией, writer corrective retry, E-E-A-T re-audit, LSI-инъекция Stage 6, необязательный Stage 8 evaluator, дополнительные meta-tag/GIST/realtime ветки и повторный анализ сайта-площадки для блоговых статей. Статическая инвентаризация репозитория обнаружила **310 мест вызова LLM**, **63 retry-конфигурации**, **99 участков параллельного выполнения** и **230 упоминаний кэширования**. Эти значения являются количеством конструкций в исходниках, а не числом HTTP-запросов одной задачи: фактическое число зависит от входных данных, feature flags, размера статьи и ответов модели.

Главный риск перерасхода был не в обычном успешном проходе, а в сочетании нескольких условий: Stage 5/6 могли выполнять несколько полных Gemini-переписываний на блок, `GEMINI_TASK_TOKEN_BUDGET` фактически оставался `Infinity` без явной ENV-переменной, retries после усечённого ответа не всегда попадали в бюджетный учёт, а Stage 8 был документирован как выключенный, хотя runtime-логика считала его включённым по умолчанию. В текущем изменении эти точки закрыты без удаления E-E-A-T, BRANDCORE/TGA, семантического роутинга или фактологических проверок.

> **Раздел 3 предыдущего security-аудита не затрагивался.** Исходные материалы BRANDCORE/TGA/Start-Prompt не добавлялись в репозиторий; в код внесены только реализованные governance-правила.

## 2. Методика и границы аудита

Аудит выполнен по runtime-коду `callLLM`, provider adapters, rate limiter, response cache, SEO orchestrator, Stage 0–8, infoArticlePipeline, linkArticlePipeline, meta-tag facade и related quality modules. Для каждой стадии отдельно различались **логический вызов `callLLM`**, **повторная попытка внутри `callLLM`** и **условный повторный проход стадии**. Поэтому запись «1 вызов, retries=3» означает один логический этап и до трёх фактических обращений к провайдеру при transient/JSON/truncation ошибках.

Среднее значение в таблице ниже — это **нормальный успешный путь без corrective/refine и без необязательных флагов**. Это не статистическое среднее production-трафика: для настоящего среднего нужны агрегированные `task_metrics`, `link_article_metrics`, `info_article_metrics` и trace-логи за период. Верхняя граница указана как условный максимум по коду; для циклов, зависящих от количества блоков, она обозначена через `B`, где `B` — число H2-блоков.

## 3. Карта вызовов по pipeline

### 3.1. Главный SEO pipeline

| Участок | Провайдер | Нормальный путь | Условные повторы и максимум | Что означает для расхода |
|---|---|---:|---|---|
| Target Page Analysis, если задан `input_target_url` | DeepSeek | 0 или 1 | До 2 provider attempts | Полезен для фактов страницы, но является дополнительным pre-stage-вызовом. |
| Audience & Niche Analysis | DeepSeek | 1 | До 2 provider attempts | Всегда выполняется и поставляет personas, JTBD, voice и terminology. |
| Pre-Stage 0: niche/opportunity/demand | DeepSeek | 3 параллельно | До 3 attempts на каждый | Хорошая параллелизация; объединять в один вызов не рекомендуется из-за раздельных контрактов и graceful degradation. |
| Stage 0: SERP Reality + Niche Landscape | DeepSeek | 2 параллельно | Fallback ещё 1, если оба результата пусты | Также запускаются GIST service и Perplexity research; это отдельные внешние расходы. |
| Stage 1: Entity, Intent, Community | DeepSeek | 3 параллельно | До 3 attempts на каждый | Уже хорошо распараллелено; три агента формируют разные сигналы. |
| Stage 2A/2B: Buyer Journey + Content Format | DeepSeek | 2 параллельно | До 3 attempts на каждый | Независимые стадии уже идут параллельно. |
| Stage 2C: Taxonomy Builder | DeepSeek | 1 | До 3 логических taxonomy attempts, каждый с `retries:2`; отдельная compact/rebuild ветка при input-too-long | Одна из главных аналитических точек стоимости и задержки. |
| Stage 2.5: Semantic LSI/n-gram routing | DeepSeek | 1 | До 3 provider attempts; JS round-robin fallback без LLM | Сохраняет семантическое качество, но является дополнительным вызовом после taxonomy. |
| Stage 3 writer, на каждый блок | Gemini/Grok | `B` | Базовый вызов + structural retry + recovery retry при отсутствии `html_content`; каждый с внутренними retries | Основной объём copywriting-стоимости. |
| Stage 4 E-E-A-T audit, на каждый блок | DeepSeek | `B` | До 3 provider attempts | Нужен для factual safety и E-E-A-T score. |
| Stage 5 PQ refine, на каждый блок | Gemini/Grok | 0 | До 3 refine-вызовов, если PQ ниже цели или naturalness не пройден; дополнительно confidence fix и по одному TF-IDF fix на каждый переиспользованный термин | Самая дорогая conditional-ветка рядом со Stage 6. |
| Re-audit после Stage 5 refine | DeepSeek | 0 | До 2 provider attempts на каждый refine | Повторный аудит нужен для проверки результата, но должен запускаться только после принятого изменения. |
| Stage 6 LSI injection, на каждый блок | Gemini/Grok | 0–1 | Исторически до 3 циклов; после исправления ранний выход при приросте менее 2 п.п. | Главная точка оптимизации: повторная полная генерация блока ради нескольких терминов. |
| Stage 7 Global Audit | DeepSeek | 1 | До 3 provider attempts | Один финальный глобальный контроль страницы. |
| Stage 7.5 meta-tags | Через meta facade | 1 логический meta-pass | В зависимости от SERP/CTR может быть fallback или regeneration | Считается отдельным meta pipeline и не всегда отражается как обычный `callLLM` trace. |
| Stage 8 Quality Evaluator | DeepSeek | 0 после исправления default | 1 логический вызов, если `STAGE8_EVALUATOR_ENABLED=true` | LLM-as-judge не меняет контент и потому выключен по умолчанию. |

В нормальном SEO-пути без URL-анализатора, fallback, retries и условных refine-веток получается приблизительно **13 обязательных логических аналитических вызовов до writer-цикла**: один Audience/Niche, три Pre-Stage 0, два Stage 0, три Stage 1, два Stage 2A/2B, один Stage 2C и один Stage 2.5. К ним добавляются `B` Gemini writer-вызовов, `B` Stage 4-аудитов, один Stage 7-аудит и переменное число Stage 5/6. Поэтому стоимость SEO-задачи определяется прежде всего числом блоков и долей блоков, которые проходят refine.

### 3.2. «Статья в блог» / infoArticle

| Участок | Провайдер | Нормальный путь | Условный повтор | Комментарий |
|---|---|---:|---|---|
| Target-site style, если задан `target_site_url` | DeepSeek | 1 на холодный URL | Повторный запуск в том же worker теперь использует TTL/LRU style cache | Кэшируется только `style_profile`, сырые тексты страниц не сохраняются. |
| Real-time Research | Perplexity | 0 или 1 параллельно | До 2 provider attempts | Сигнал качества, но отдельный внешний расход. |
| Pre-Stage 0, Stage 0, Stage 1 | DeepSeek | По 1 каждому | До 3 attempts на этап | Последовательная аналитическая цепочка. |
| Stage 1B whitespace + Google SERP/GIST | DeepSeek + external services | 1 DeepSeek + SERP/GIST ветка | Внешняя ветка fail-open | SERP-fetch и GIST выполняются параллельно с whitespace. |
| Stage 2 outline | DeepSeek | 1 | До 3 attempts | Формирует структуру статьи. |
| Stage 2B LSI synthesis | DeepSeek | 1 логический pipeline | Может иметь corrective call внутри lsi module | Должен сохранять общий LSI-контракт. |
| Stage 2C semantic link planner | DeepSeek/детерминированный planner | 0–1 LLM | Deterministic shortlist и validator без LLM | При отсутствии Excel-п базы LLM-аудит ссылок пропускается. |
| Stage 3 writer | Gemini | 1 | До 1 corrective writer pass, каждый call с retries | Полный текст, поэтому один retry дорогой. |
| E-E-A-T audit | DeepSeek | 1 | Для длинных статей chunked-аудит: по одному вызову на H2-chunk и до одного retry на chunk | Включение chunked mode повышает factual granularity, но меняет расход пропорционально длине. |
| Link audit | DeepSeek | 0 или 1 | Обычно один вызов при наличии link plan | Deterministic audit остаётся ground truth; LLM только объясняет semantic violations. |
| Writer refine + re-audit | Gemini + DeepSeek | 0 | До 1 writer refine и повторных E-E-A-T/link audit | Срабатывает по EEAT, links, LSI или BioBrain fast reject. |
| GIST audit + GIST refine | DeepSeek + Gemini | 0 | До 1 GIST audit, 1 writer refine и 1 re-audit | Срабатывает при наличии information delta. |
| Image prompts | DeepSeek | 1 | До 3 provider attempts | Изображения генерируются отдельным non-text provider path. |
| meta-tags | Через meta facade | 1 логический meta-pass | Возможна CTR regeneration/fallback | Учитывается отдельно от основного writer. |
| Stage 8 evaluator | DeepSeek | 0 после исправления default | 1 при явном включении | Не влияет на финальный текст, поэтому не должен быть обязательным. |

Для infoArticle прежняя статическая оценка в **17 LLM call sites** объясняется тем, что в одном файле собраны базовые stages, writer corrective pass, E-E-A-T/link/GIST audit, image prompts и optional branches. В реальном успешном пути часть из них не запускается, но длинная статья с links, information delta и низким EEAT может получить несколько дополнительных writer/audit проходов.

### 3.3. Ссылочная статья / linkArticle

| Участок | Провайдер | Нормальный путь | Условный повтор | Комментарий |
|---|---|---:|---|---|
| Pre-Stage 0, Audience, Intents, Whitespace | DeepSeek | 4 | До 3 attempts на этап | Последовательная аналитика темы и аудитории. |
| Google SERP + GIST delta | External services | 0 или 1 ветка | Fail-open | Даёт content gaps и purchase brief inputs. |
| Competitive purchase brief | DeepSeek | 1 | До 2 attempts | Дополнительный §10/§11 analyst-вызов. |
| Structure | DeepSeek | 1 | До 3 attempts | Формирует outline и anchor plan. |
| Stage 3 writer | Gemini/Grok | 1 | До 1 corrective retry | Полный writer-проход. |
| E-E-A-T audit | DeepSeek | 1 | До 3 attempts | Link pipeline использует single-call core, без info chunkOpts. |
| Quality refine + re-audit | Gemini/Grok + DeepSeek | 0 | До 1 writer refine и 1 E-E-A-T re-audit | Срабатывает по EEAT, LSI или banned-pattern checks. |
| Image prompts | DeepSeek | 1 | До 3 attempts | Отдельный prompt-generation stage. |
| Stage 8 evaluator | DeepSeek | 0 после исправления default | 1 при явном включении | LLM-as-judge, не writer. |
| Meta-tags | Через meta facade | 1 логический meta-pass | CTR regeneration/fallback возможны | Не следует смешивать с базовым writer cost. |

В статическом отчёте linkArticle содержит **15 callLLM-конструкций**. Нормальный путь обычно заметно короче этой верхней инвентаризации, но optional real-time research, GIST analyst, quality refine, meta facade и Stage 8 могут вернуть его к исходной оценке или выше.

## 4. Топ-5 точек перерасхода и внесённые изменения

| Приоритет | Точка перерасхода | Риск до исправления | Что сделано | Ожидаемый эффект |
|---:|---|---|---|---|
| 1 | Stage 6 LSI injection: до 3 полных Gemini-правок каждого блока | `3 × B` логических вызова только на LSI при слабом покрытии; повтор может не добавлять новые термины | Добавлен `SEO_STAGE6_MAX_LOOPS` и ранний выход, если прирост coverage меньше `SEO_STAGE6_MIN_COVERAGE_GAIN_PCT` (по умолчанию 2 п.п.) | В типичном случае экономится один или более лишних циклов на блоке; качество сохраняется через best-so-far и текущий length guard. |
| 2 | `GEMINI_TASK_TOKEN_BUDGET` был `Infinity` без ENV | Патологический refine/retry мог расходовать токены без task-level stop | Введён конечный production default **200 000 input tokens**; `0` оставлен явным opt-out | Runaway-задача перестаёт бесконтрольно расходовать Gemini/Grok input tokens. |
| 3 | Budget учитывал только успешно распарсированный ответ и не защищал параллельные pre-check | Truncated/JSON-failure retries и параллельные вызовы могли выйти за лимит | Добавлен reservation prompt budget до HTTP-вызова, commit actual usage после ответа и release при ошибке | Лимит стал race-safe на уровне одного Node process и учитывает retries после truncation. |
| 4 | Stage 8 был фактически включён по умолчанию при документации «default OFF» | Один дополнительный DeepSeek judge-вызов на каждую SEO/info/link задачу без изменения текста | Runtime приведён к `STAGE8_EVALUATOR_ENABLED=true` для включения | Экономится один DeepSeek-вызов на задачу в обычном production-пути. |
| 5 | Анализ `target_site_url` повторял scrape и DeepSeek style analysis для одинаковых площадок | Один дополнительный DeepSeek-вызов на каждую блоговую задачу с одной и той же площадкой | Добавлен process-local TTL/LRU cache профиля на 24 часа, максимум 128 записей; в log виден `[style-cache hit]` | Повторные задачи в одном worker используют готовый профиль без scrape/LLM. |

Отдельно остаётся важный, но намеренно не агрессивно урезанный расход: writer corrective/refine и E-E-A-T audits. Они влияют на полноту, E-E-A-T и соблюдение ссылочного плана, поэтому их безусловное удаление ухудшило бы качество и стабильность публикации. Оптимальный следующий шаг для них — собирать production-метрики «до/после», а затем снижать retries только для конкретных категорий ошибок.

## 5. Топ-5 точек ускорения

| Приоритет | Ускорение | Состояние |
|---:|---|---|
| 1 | Ранний Stage 6 exit по приросту покрытия | Внедрено. Неудачная или малополезная LSI-итерация больше не обязана запускать следующий полный Gemini rewrite. |
| 2 | Параллельный Pre-Stage 0, Stage 0, Stage 1 и Stage 2A/2B | Уже реализовано до аудита; это правильный уровень параллелизма, так как агенты независимы. |
| 3 | Gemini Context Cache для AKB/IAKB/LAKB | Уже реализовано opt-in. В production рекомендуется включать после проверки квоты и TTL провайдера. |
| 4 | Redis response cache | В `.env.example` добавлена production-рекомендация `LLM_RESPONSE_CACHE_ENABLED=true`; кэш brand-scoped, ограничен по размеру и fail-open. Включение в конкретном окружении остаётся операционным решением владельца Redis. |
| 5 | TTL/LRU cache target-site style | Внедрено для повторных blog tasks в рамках одного worker process. Для межпроцессного reuse следующим шагом можно вынести только compact profile в Redis с отдельным TTL. |

Объединять Stage 0 и Stage 1 в один большой LLM-вызов не рекомендуется: Stage 1 получает разные независимые контракты Entity/Intent/Community, а текущая параллельная схема сокращает wall-clock time без потери специализации. Объединение увеличило бы размер промпта, вероятность неполного JSON и стоимость повторного вызова при частичном сбое.

## 6. Топ-5 точек улучшения качества

| Приоритет | Улучшение | Практический смысл для Google и Яндекса |
|---:|---|---|
| 1 | BRANDCORE/TGA governance в writer stages и quality gate | Факты, claims, E-E-A-T и manual-review состояние проходят через единый контекст для SEO, link, info и meta-tags. Это снижает риск неподтверждённых обещаний и рассинхронизации бренда. |
| 2 | Удержание semantic coverage через Stage 2.5 routing и Stage 6 | LSI/n-gram термины распределяются по релевантным H2, а не добавляются случайным списком; ранний выход не меняет цель покрытия и не разрешает переписывать блок без результата. |
| 3 | E-E-A-T и factual safety как отдельный audit layer | Stage 4/5, info E-E-A-T core и governance не заменяются одним judge-вызовом. Для YMYL и коммерческих тем это важнее механического увеличения keyword density. |
| 4 | SERP evidence/GIST/relevance как проверяемые сигналы | Конкурентные gaps, user questions, entities, format patterns и information delta должны использоваться как evidence, а не как повод выдумывать факты. Существующие fail-open ветки позволяют не блокировать задачу при недоступности внешнего источника. |
| 5 | Production telemetry по refine ratio и coverage gain | Для каждой задачи нужно агрегировать число writer calls, `stage6_cycles`, coverage до/после, PQ/EEAT, cache hits, tokens in/out и cost. После 2–4 недель данных пороги можно калибровать по нишам, а не задавать одинаковый лимит для всех. |

## 7. Production ENV-рекомендации

Следующий набор подходит как стартовая конфигурация для production. Если Redis используется совместно несколькими окружениями, перед включением response cache нужно проверить политики доступа и TTL; исходные промпты в ключи не записываются, ключи имеют brand namespace, а кэш fail-open.

```dotenv
# Жёсткая защита расходов Gemini/Grok на одну задачу.
GEMINI_TASK_TOKEN_BUDGET=200000

# Повторное использование детерминированных ответов между одинаковыми задачами.
LLM_RESPONSE_CACHE_ENABLED=true
LLM_RESPONSE_CACHE_TTL_SECONDS=604800

# SEO LSI injection guard.
SEO_STAGE6_MAX_LOOPS=3
SEO_STAGE6_MIN_COVERAGE_GAIN_PCT=2

# LLM-as-judge — отдельно включать для sampling/diagnostics, не для каждого запуска.
STAGE8_EVALUATOR_ENABLED=false

# Уже существующие provider semaphores.
DEEPSEEK_MAX_CONCURRENT=8
GEMINI_MAX_CONCURRENT=6
XAI_MAX_CONCURRENT=4
LLM_QUEUE_WARN_MS=5000

# Gemini server-side context caching — включать при доступной квоте.
GEMINI_CONTEXT_CACHE_ENABLED=true
INFO_ARTICLE_GEMINI_CACHE_ENABLED=true
LINK_ARTICLE_GEMINI_CACHE_ENABLED=true

# Style profile reuse для блоговых публикаций.
INFO_ARTICLE_TARGET_STYLE_CACHE_TTL_MS=86400000
INFO_ARTICLE_TARGET_STYLE_CACHE_MAX=128
```

Для аварийной диагностики runaway-задачи допускается временно поставить меньший `GEMINI_TASK_TOKEN_BUDGET`, например `100000`, и посмотреть, какие стадии получают `BudgetExceededError`. Явное значение `0` отключает budget guard; использовать его следует только для controlled benchmark, а не для обычной очереди.

## 8. Внесённые файлы

| Файл | Изменение |
|---|---|
| `backend/src/services/llm/callLLM.js` | Конечный task budget default, concurrent reservation, учёт provider attempts и traceTaskId. |
| `backend/src/services/pipeline/orchestrator.js` | SEO pipeline использует единый configured budget вместо скрытого `Infinity`. |
| `backend/src/services/pipeline/stage6.js` | Настраиваемый max loops и ранний выход по приросту LSI coverage. |
| `backend/src/services/pipeline/stage8.js` | Исправлено реальное default-поведение на OFF. |
| `backend/src/services/infoArticle/infoArticlePipeline.js` | Общий budget lifecycle и лог cache hit target-site profile. |
| `backend/src/services/infoArticle/infoArticleKnowledgeBase.js` | Передача task budget в writer opts. |
| `backend/src/services/infoArticle/targetSiteStyle.js` | 24-часовой process-local TTL/LRU cache compact style profile. |
| `backend/src/services/linkArticle/linkArticlePipeline.js` | Общий budget lifecycle для linkArticle. |
| `backend/src/services/linkArticle/linkArticleKnowledgeBase.js` | Передача task budget в writer opts. |
| `.env.example` | Production-рекомендации для budget, response cache, Stage 6, Stage 8 и style cache. |
| `backend/scripts/test-content-generator-cost-guards.js` | Smoke tests новых guard-контрактов. |

## 9. Проверки и ограничения

Синтаксическая проверка всех изменённых JavaScript-файлов прошла успешно. Новый smoke test проверил конечный budget default, explicit override, explicit opt-out, Stage 8 default-off и передачу budget в IAKB/LAKB. Существующие релевантные тесты response-cache, quality evaluator, quality core и info-article quality layers также прошли без ошибок: соответственно **все 25**, **8**, **54** и **31** проверка успешны.

Команда `npm run lint` не была использована как критерий качества результата: в backend отсутствует ESLint configuration, поэтому ESLint завершился сообщением о невозможности найти конфигурационный файл. Это инфраструктурный недостаток репозитория, а не ошибка новых файлов; его можно вынести в отдельное техническое задание, не смешивая с текущим контентным аудитом.

Точные денежные проценты экономии нельзя честно вычислить только статическим анализом: для этого нужны production usage logs. До подключения telemetry следует считать изменения защитой от worst-case расхода и ускорением повторных задач, а не гарантией фиксированного процента экономии. После накопления данных можно построить фактические распределения `tokens_in`, `tokens_out`, cost, retry rate, Stage 6 gain и cache-hit rate по каждому pipeline.

## References

[1]: backend/src/services/llm/callLLM.js "Центральный LLM wrapper: retries, cache, budget и usage"

[2]: backend/src/services/pipeline/orchestrator.js "SEO orchestrator и Stage 0–8 lifecycle"

[3]: backend/src/services/pipeline/stage6.js "LSI injection loop и ранний выход"

[4]: backend/src/services/pipeline/stage8.js "Quality Evaluator и feature flag"

[5]: backend/src/services/infoArticle/infoArticlePipeline.js "InfoArticle pipeline"

[6]: backend/src/services/linkArticle/linkArticlePipeline.js "LinkArticle pipeline"

[7]: backend/src/services/llm/responseCache.js "Brand-scoped Redis response cache"

[8]: backend/src/services/llm/rateLimiter.js "Provider concurrency semaphore"

[9]: backend/src/services/contentGovernance.js "BRANDCORE/TGA governance layer"

[10]: backend/scripts/test-content-generator-cost-guards.js "Smoke tests cost guards"
