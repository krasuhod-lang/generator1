# Модуль `metaTags` — движок мета-тегов (SEO Genius v4.1)

Единый движок генерации `title` / `description` / `h1` для всех контентных
пайплайнов проекта. Ядро — **GIST Meta Filter** (`gistMetaFilter.js`):
многошаговый DSPy-подобный пайплайн, который сначала добывает фактические
«крючки» (GIST-факты), фильтрует их по конверсионности и только затем
собирает пару Title/Description.

## Карта модуля

| Файл | Роль |
|---|---|
| `metaFacade.js` | **Единая точка входа** контентных пайплайнов: seo / info / link (см. ниже) |
| `metaStages.js` | Полный прогон по ключу: SERP → семантика → обогащение → GIST → LSI-чек → CTR-скор |
| `metaGenerator.js` | `generateDrMaxMeta` — обёртка над GIST, длины, `detectYear`, `postValidate` |
| `gistMetaFilter.js` | Ядро GIST: кандидаты фактов → фильтр → сборка пары → конфликты → рефрейминг длин |
| `gistMetaPrompts.js` | Системные/пользовательские промпты шагов GIST |
| `metaContext.js` | Детерминированная сборка `pageAngle`, `missingNodes` (факты) и `avoidPatterns` (запреты) |
| `lengthConfig.js` | **Единая точка правды по длинам**: целевые коридоры и жёсткие максимумы Title/Description |
| `metaNotes.js` | Русификация причин ручной проверки + группировка заметок на ошибки / предупреждения / рекомендации |
| `ctrScore.js` | Детерминированный `snippetCtrScore` (0–100), без сетевых вызовов |
| `lengthHelpers.js` | Длины, безопасные диапазоны, CTA-безопасное сжатие |
| `serpCtrAnalyzer.js` / `snippetAnalyzer.js` / `semantics.js` | Анализ выдачи и семантики |
| `pipeline.js` | Массовая генерация для инструмента мета-тегов (`meta_tag_tasks`) — работает по списку ключей без готового контента, поэтому зовёт `metaStages` напрямую, минуя фасад |

## Фасад: `generateMetaForContent`

```js
const { generateMetaForContent } = require('.../metaTags/metaFacade');

const meta = await generateMetaForContent({
  keyword: 'монтаж вентиляции',
  pipeline: 'seo',            // 'seo' | 'info' | 'link' | 'meta_tool'
  html,                       // финальный HTML статьи (для summary)
  plain,                      // текстовая версия (fallback для summary)
  context: {
    brand, niche, toponym, phone,
    summary,                   // если не задан — соберётся из html/plain
    price_data,
    pageAngle,                 // позиционирование страницы
    missingNodes: [],          // пробелы конкурентов / уникальные факты
    standalone_exposure: false,// true для контента, живущего вне SERP
    audienceNicheDigest,       // переиспользуется, повторно не считается
    relevanceBrief,
    llm_provider: 'gemini',
    gemini_model: '',
    useSerp: true,             // false — сразу GIST без выдачи
    anchorText, focusNotes,    // только pipeline: 'link'
  },
  ctx: {
    taskId,
    log: (msg, level) => {},
    // Единая для проекта сигнатура (как у оркестратора и recordTextTokens):
    onTokens: (provider, tokensIn, tokensOut, costUsd) => {},
    persistMetrics: true,      // false — не писать метрики самому
  },
});
```

> Имена полей контекста в snake_case (`price_data`, `standalone_exposure`,
> `llm_provider`) — именно так их читает фасад; camelCase-варианты
> игнорируются.

### Пайплайны

| `pipeline` | Движок ветки без SERP | Особенности |
|---|---|---|
| `seo` | `generateDrMaxMeta` | Stage 7.5 оркестратора, метрики пишутся в `task_metrics` |
| `info` | `generateDrMaxMeta` | `standalone_exposure: true`, расход → `recordTextTokens` |
| `link` | `generateLinkArticleMeta` | `useSerp: false` (публикация на доноре), `source: gist_link` |
| `meta_tool` | `generateDrMaxMeta` | инструмент мета-тегов использует `pipeline.js` напрямую (массовый режим по ключам) |

### Каскад деградации

1. `runMetaStagesForKeyword` — полный прогон с выдачей (`source: 'gist_serp'`);
2. `generateDrMaxMeta` с пустым `serpData` — GIST работает и без выдачи
   (`source: 'gist'`; для `pipeline: 'link'` — `generateLinkArticleMeta`,
   `source: 'gist_link'`);
3. `infoArticle/seoMeta.service` — прежний одиночный вызов (`source: 'legacy_*'`);
4. пустой контракт с `manual_review_required: true` (`source: 'failed'`).

Любая ошибка внутри фасада — это `warn`-лог и переход на следующую ступень:
модуль **никогда не роняет** контентный пайплайн.

### Контракт возврата

```js
{
  title, description, h1, description_mobile,
  source,                  // gist_serp | gist | gist_link | legacy_* | failed
  gist_fact,               // факт, легший в основу пары
  gist_fact_source,        // как факт получен (winner_source движка)
  ctr_score,               // { score, breakdown, penalties, needs_review, threshold }
  lsi_check,               // покрытие LSI — метрика качества, не жёсткое требование
  context_used,            // { page_angle, missing_nodes, missing_nodes_applied, standalone_exposure }
  manual_review_required,
  notes: [],               // плоский список (совместимость); группировка — в post_validation_report
  usage: { tokensIn, tokensOut, thoughtsTokens, cachedTokens, cost, model, provider },
}
```

## ENV-флаги

| Переменная | Дефолт | Назначение |
|---|---|---|
| `META_FACADE_ENABLED` | `true` | Kill-switch фасада: при `false` все пайплайны работают как раньше (legacy-движок) |
| `META_FACADE_SERP_ENABLED` | `true` | При `false` фасад не ходит в выдачу и сразу использует GIST без SERP |
| `META_LENGTH_REFRAME_ENABLED` | `true` | LLM-рефрейминг при превышении длин (шаг 1 стратегии сжатия) |
| `META_CTR_SCORE_THRESHOLD` | `60` | Порог CTR-скора, ниже которого делается одна автоперегенерация и ставится пометка «нужна ручная проверка» |

## Длины: единая точка правды

Коридоры живут в `lengthConfig.js` и оттуда расходятся в `gistMetaFilter`,
`metaGenerator`, `ctrScore`, промпты и (через `GET /api/meta-tags/limits`) в UI.
Раньше числа дублировались, и страница результатов подсвечивала свой коридор
(40–50 / 130–145), которого движок никогда не достигал.

| Поле | Целевой коридор | Жёсткий максимум |
|---|---|---|
| Title | 60–70 | 80 |
| Description (desktop) | 150–170 | 190 |
| Description (mobile) | 90–105 | 105 |
| H1 | — | 70 |

Целевой коридор — то, за что `snippetCtrScore` даёт полный балл; попадание
между целью и жёстким максимумом даёт половину. Description сознательно
смещён вниз: в описании на 185+ символов третье предложение почти всегда вода.

## Ключевые правила качества

- **Факты отдельно, запреты отдельно.** `buildMissingNodes` возвращает только
  реальные смысловые пробелы (уникальные LSI, неиспользованные гео/год/цена);
  анти-паттерны ТОПа, клише конкурентов и «CTA редок» уходят в
  `buildAvoidPatterns` и передаются в промпт блоком «[НЕ ПОВТОРЯТЬ]». Пока они
  лежали в одном списке, модель брала «отсеиваем рекламный шум» как факт для
  описания.
- **Клише ≠ лексика ниши.** `analyzeSnippets` делит повторы ТОПа на
  `competitor_cliches` (порог ≥3 документов или ≥40% выдачи — жёсткий запрет,
  штрафуется в `ctrScore`) и `niche_lexicon` (частотная лексика: использовать
  можно, но не как дифференциатор). `competitor_noise` сохранён как алиас
  клише для обратной совместимости.
- **Запрет мета-речи.** `PAIR_ASSEMBLER_SYSTEM` запрещает рассказ о собственном
  процессе («мы не выдаём», «отсеиваем шум», «наш помощник сравнил»), задаёт
  структуру «что получает пользователь → чем подтверждается → одно действие»,
  правила под интент выдачи и few-shot «плохо → хорошо».
- **Best-of.** Каждая попытка сборки пары скорится `snippetCtrScore`; наружу
  идёт лучшая (сначала — прошедшая conflict/replaceability, затем — по скору),
  а не последняя по циклу.
- **Кириллические границы слов.** В JS `\b` и `\w` не работают с кириллицей,
  поэтому guard'ы (`PRICE_MENTION_RE`, `CTA_RE`) используют
  `(?<![а-яё])` / `(?![а-яё])`. Иначе «оценка» и «процент» считались
  упоминанием цены, а `подробн\w*` вообще не матчился.
- **CTA не режется.** При превышении длины работает трёхуровневая стратегия:
  LLM-рефрейминг → детерминированное сжатие тела с сохранением CTA
  (`compressPreservingCta`) → механическая обрезка. Вставка бренда делается до
  финальной проверки и не за счёт CTA.
- **Анти-стаффинг LSI.** Промпты требуют органично вплести 2–3 приоритетных
  LSI + 1–2 дифференциатора; читаемость и CTR приоритетнее полноты покрытия.
  `checkLsiUsage` остаётся метрикой качества и подсказкой редактору.
- **Год.** `detectYear` нормализует год к диапазону `[currentYear, currentYear + 1]`;
  при маркерах исторического контекста год в Title не форсируется. Год считается
  один раз и прокидывается в GIST через `inputs.current_year`.

## Учёт расхода

Движок GIST зовёт адаптеры LLM напрямую (минуя `callLLM`), поэтому стоимость
считает сам фасад — по тем же тарифам (`metrics/priceCalculator.calcCost`), с
учётом `thoughtsTokens` / `cachedTokens`. Результат:

- всегда → `pipeline_traces` (stage `meta_tags`);
- `pipeline: 'seo'` → `task_metrics` + `task_stages` (у `tasks` есть FK);
- `info` / `link` → собственные счётчики задачи через `ctx.onTokens`
  (`recordTextTokens`), фасад в `task_metrics` не пишет.

Любая ошибка записи метрик — только `warn`, генерация не прерывается.
Автоперегенерация при низком CTR-скоре (§8) выполняет второй полный прогон —
его расход складывается с первым (`metaStages.mergeUsageMeta`), поэтому в
отчётность попадает полная стоимость обеих версий.

## Хранение

- Основной SEO-пайплайн: `tasks.seo_title`, `tasks.seo_description`, `tasks.seo_meta` (JSONB) — миграция `127_tasks_seo_meta.sql`.
- Инфо-статьи: `info_article_tasks.seo_title`, `seo_description` (миграция 057) + `seo_meta_report` (JSONB, миграция 127). Если колонки нет — в лог задачи уходит предупреждение, сами Title/Description сохраняются.
- Ссылочные статьи: `link_article_tasks.meta_tags` (JSONB) — тот же контракт фасада. UI поддерживает и старые строки (`winner_fact` / `winner_source`).

## Тесты

```bash
node backend/scripts/test-meta-clickability.js   # длины/CTA-лексикон, price-guard, стоп-слова, CTR-скор, missingNodes vs avoidPatterns, metaNotes
node backend/scripts/test-meta-facade.js         # каскад деградации фасада с моками LLM/SERP
node backend/scripts/test-gist-meta-filter.js    # ядро GIST: коридоры длин, best-of, промпты
node backend/scripts/test-meta-serp-ctr.js       # анализ выдачи, интент, price_data
```
