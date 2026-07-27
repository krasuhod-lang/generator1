# Модуль `metaTags` — движок мета-тегов (SEO Genius v4.1)

Единый движок генерации `title` / `description` / `h1` для всех контентных
пайплайнов проекта. Ядро — **GIST Meta Filter** (`gistMetaFilter.js`):
многошаговый DSPy-подобный пайплайн, который сначала добывает фактические
«крючки» (GIST-факты), фильтрует их по конверсионности и только затем
собирает пару Title/Description.

## Карта модуля

| Файл | Роль |
|---|---|
| `metaFacade.js` | **Единая точка входа** для всех пайплайнов (см. ниже) |
| `metaStages.js` | Полный прогон по ключу: SERP → семантика → обогащение → GIST → LSI-чек → CTR-скор |
| `metaGenerator.js` | `generateDrMaxMeta` — обёртка над GIST, длины, `detectYear`, `postValidate` |
| `gistMetaFilter.js` | Ядро GIST: кандидаты фактов → фильтр → сборка пары → конфликты → рефрейминг длин |
| `gistMetaPrompts.js` | Системные/пользовательские промпты шагов GIST |
| `metaContext.js` | Детерминированная сборка `pageAngle` и `missingNodes` |
| `ctrScore.js` | Детерминированный `snippetCtrScore` (0–100), без сетевых вызовов |
| `lengthHelpers.js` | Длины, безопасные диапазоны, CTA-безопасное сжатие |
| `serpCtrAnalyzer.js` / `snippetAnalyzer.js` / `semantics.js` | Анализ выдачи и семантики |
| `pipeline.js` | Массовая генерация для инструмента мета-тегов (`meta_tag_tasks`) |

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
    summary,                  // если не задан — соберётся из html/plain
    priceData,
    pageAngle,                // позиционирование страницы
    missingNodes: [],         // пробелы конкурентов / уникальные факты
    standaloneExposure: false,// true для контента, живущего вне SERP
    audienceNicheDigest,      // переиспользуется, повторно не считается
    relevanceBrief,
    llmProvider: 'gemini',
  },
  ctx: { onTokens: (tokensIn, tokensOut, costUsd) => {} },
});
```

### Каскад деградации

1. `runMetaStagesForKeyword` — полный прогон с выдачей (`source: 'gist_serp'`);
2. `generateDrMaxMeta` с пустым `serpData` — GIST работает и без выдачи (`source: 'gist'`);
3. `infoArticle/seoMeta.service` — прежний одиночный вызов (`source: 'legacy_*'`);
4. пустой контракт с `manual_review_required: true` (`source: 'failed'`).

Любая ошибка внутри фасада — это `warn`-лог и переход на следующую ступень:
модуль **никогда не роняет** контентный пайплайн.

### Контракт возврата

```js
{
  title, description, h1, description_mobile,
  source,                  // gist_serp | gist | legacy_* | failed
  gist_fact,               // факт, легший в основу пары
  ctr_score,               // { score, breakdown, penalties, needs_review, threshold }
  lsi_check,               // покрытие LSI — метрика качества, не жёсткое требование
  context_used,            // { page_angle, missing_nodes, missing_nodes_applied, standalone_exposure }
  manual_review_required,
  notes: [],
  usage: { tokensIn, tokensOut, cost },
}
```

## ENV-флаги

| Переменная | Дефолт | Назначение |
|---|---|---|
| `META_FACADE_ENABLED` | `true` | Kill-switch фасада: при `false` все пайплайны работают как раньше (legacy-движок) |
| `META_FACADE_SERP_ENABLED` | `true` | При `false` фасад не ходит в выдачу и сразу использует GIST без SERP |
| `META_LENGTH_REFRAME_ENABLED` | `true` | LLM-рефрейминг при превышении длин (шаг 1 стратегии сжатия) |
| `META_CTR_SCORE_THRESHOLD` | `60` | Порог CTR-скора, ниже которого делается одна автоперегенерация и ставится пометка «нужна ручная проверка» |

## Ключевые правила качества

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

## Хранение

- Основной SEO-пайплайн: `tasks.seo_title`, `tasks.seo_description`, `tasks.seo_meta` (JSONB) — миграция `127_tasks_seo_meta.sql`.
- Инфо-статьи: `info_article_tasks.seo_title`, `seo_description` (миграция 057) + `seo_meta_report` (JSONB, миграция 127).

## Тесты

```bash
node backend/scripts/test-meta-clickability.js   # длины/CTA, detectYear, CTR-скор, pageAngle/missingNodes
node backend/scripts/test-meta-facade.js         # каскад деградации фасада с моками LLM/SERP
node backend/scripts/test-gist-meta-filter.js    # ядро GIST
```
