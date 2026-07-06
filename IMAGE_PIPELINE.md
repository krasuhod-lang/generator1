# Content-grounded Image Pipeline (`services/images`)

Смысловой (content-grounded) пайплайн генерации изображений для статей.
Изображения планируются **по содержанию конкретного блока статьи**, а не по
правилу «есть `<h2>` → нужна картинка». Для каждого блока определяется
визуальная задача, извлекается сцена из контента, собирается grounded-промпт,
затем изображение проходит **семантический** QA (не только технический) и
доставляется в production-режиме (файл/URL) вместо сырого base64.

Всё спрятано за feature-флагами. **При выключенных флагах поведение legacy
не меняется** (полная обратная совместимость): используется старая
section-based схема (`runImagePromptsGen`).

---

## Новый принцип

```
есть блок статьи
  → определяем визуальную задачу (imageIntentPlanner)
  → решаем, нужна ли картинка
  → извлекаем сцену из контента (imageSceneExtractor)
  → строим grounded prompt (imagePromptComposer)
  → генерируем (nanoBananaPro.adapter, без изменений)
  → технический QA (imageQa.service, без изменений)
  → семантический QA (semanticImageQa.service)
  → доставляем в production (imageStorage.service)
  → image quality gate (imageQualityGate)
  → встраиваем в HTML (embedImages: <figure>/<img> URL|base64)
```

Изображение считается **полезным**, если решает хотя бы одну задачу:
ускоряет понимание процесса; визуализирует описываемый объект; помогает
сравнить варианты; усиливает доверие/конкретику; показывает контекст
использования; поддерживает обучающую/объясняющую функцию блока. Чисто
декоративные слоты отклоняются на этапе планирования (`need_image=false`).

---

## Модули

| Файл | Назначение |
|------|------------|
| `config.js` | Чтение `IMAGE_PIPELINE_*` ENV → замороженный snapshot; `getImageConfig()`, `isNewPipelineEnabled()`. |
| `slug.js` | `transliterate()`, `slugify()` — RU→LAT для `filename_slug`. |
| `textSignals.js` | Детерминированный разбор текста блока: маркеры process/comparison/object/trust/usage + оценка абстрактности. |
| `imageIntentPlanner.js` | `planImageIntents()` — нужен ли визуал в блоке и какого типа (`image_intent`), `value_reason`, `placement_mode`, `priority`. Обложка планируется при наличии topic. |
| `imageSceneExtractor.js` | `extractScene()` — scene graph (subject/environment/action/objects/must_include/must_avoid/composition/factual_anchors) + `generic_risk`, `fallback_used`. |
| `imagePromptComposer.js` | `composePrompt()` — `visual_prompt`, `negative_prompt`, `alt_ru`, `caption_ru`, `style_label`, `filename_slug`. Экспортирует `NEGATIVE_BASE`, `NEGATIVE_STRICT_EXTRA`. |
| `semanticImageQa.service.js` | `runSemanticImageQa()` — relevance/usefulness/generic/editorial_fit/composition_diversity/text_in_image_risk/scene_fidelity → verdict `pass`/`review`/`fail`. Никогда не бросает. |
| `imageStorage.service.js` | `persistImages()` — `inline_base64` (fallback) или `cdn_upload` (файлы по slug-пути) → `image_url`, `width`, `height`, `mime_type`, `filesize_bytes`. |
| `imageQualityGate.js` | `evaluateImageGate()` — агрегат технического+семантического QA+storage → `canFinalize`, `blockers`, `warnings`, `verdict`. Fail-open. |
| `index.js` | Фасад: `buildGroundedImagePrompts()` (intent→scene→prompt) + реэкспорт. |

> Все модули **детерминированы** (без сети/LLM) — как существующий
> `imageQa.service`. Это делает их тестируемыми офлайн
> (`node backend/scripts/test-images-pipeline.js`). LLM-версии можно
> надстроить позже, не меняя контракт.

---

## Типы изображений (`image_intent`)

`cover` · `explainer_scene` · `comparison_scene` · `step_visual` ·
`object_visual` · `trust_visual` · `context_visual` · `do_not_generate`.

---

## Обогащённый image slot

Новые поля живут **внутри существующего JSONB-массива `image_prompts`** —
отдельные колонки не заводятся, старые задачи читаются без миграции полей:

```
image_intent, value_reason, scene_json, generic_risk, placement_mode,
anchor_block_id, caption_ru, filename_slug, storage_mode, image_url,
width, height, filesize_bytes, semantic_qa_result, semantic_qa_scores
```

Дополнительно migration `100_image_pipeline.sql` добавляет два колонки-отчёта
в `info_article_tasks` и `link_article_tasks`:
`image_semantic_qa_report` (JSONB), `image_gate` (JSONB).

---

## Встраивание (embedImages)

- **cover** — после первого блока, как и раньше.
- **inline** — по `anchor_block_id`/ближайшему релевантному якорю (infoArticle),
  либо через плейсхолдеры `<!-- IMAGE_SLOT_i -->` (linkArticle).
- `storage_mode=cdn_upload` → `<img src="URL" loading="lazy" decoding="async"
  width height>`; `inline_base64` → `data:`-URI (fallback).
- При наличии `caption_ru` — `<figure>…<figcaption>`.

---

## Quality Gate по изображениям

Статья **блокируется** (`canFinalize=false`), если:
cover = `fail`; более половины inline = `fail`; отсутствует `alt_ru`;
включён `IMAGE_PIPELINE_REQUIRE_PRODUCTION_URL`, но `image_url` не получен;
`generic_score` выше порога; слот сгенерирован при `image_intent=do_not_generate`.

Статья уходит в **review**, если: хотя бы одно изображение = `review`;
низкая полезность; ≥2 картинки с низкой композиционной вариативностью.

Гейт **fail-open**: любая внутренняя ошибка не роняет pipeline
(поведение как у `qualityGate.runForTask`).

---

## ENV-конфигурация

Полный список — в `.env.example` (блок «Content-grounded Image Pipeline»).

| Переменная | Default | Назначение |
|------------|---------|------------|
| `IMAGE_PIPELINE_ENABLE_INTENT_PLANNER` | `false` | Планирование потребности/типа визуала. |
| `IMAGE_PIPELINE_ENABLE_SCENE_EXTRACTION` | `false` | Извлечение сцены из контента блока. |
| `IMAGE_PIPELINE_ENABLE_SEMANTIC_QA` | `false` | Семантический QA + влияние на gate. |
| `IMAGE_PIPELINE_STORAGE_MODE` | `inline_base64` | `inline_base64` \| `cdn_upload`. |
| `IMAGE_PIPELINE_REQUIRE_PRODUCTION_URL` | `false` | `true` → нет `image_url` = блок gate. |
| `IMAGE_PIPELINE_GENERIC_SCORE_THRESHOLD` | `0.65` | Порог «шаблонности» (0..1). |
| `IMAGE_PIPELINE_MAX_INLINE_IMAGES` | `6` | Максимум inline-картинок (кроме обложки). |
| `IMAGE_PIPELINE_EDITORIAL_MODE_DEFAULT` | `strict` | Усиление negative_prompt (linkArticle). |
| `IMAGE_PIPELINE_SEMANTIC_QA_FALLBACK` | `warn_only` | `warn_only` \| `hard_fail`. |
| `IMAGE_PIPELINE_STORAGE_DIR` | — | Корень для `cdn_upload`-файлов. |
| `IMAGE_PIPELINE_PUBLIC_BASE_URL` | — | Базовый URL, под которым доступна `STORAGE_DIR`. |

Включить grounded-ветку достаточно любого из
`ENABLE_INTENT_PLANNER` / `ENABLE_SCENE_EXTRACTION`
(см. `isNewPipelineEnabled`).

---

## Обратная совместимость

- Новый flow активируется только флагами; по умолчанию **всё ВЫКЛЮЧЕНО** →
  используется legacy section-based схема.
- Новые поля не ломают чтение старых задач (лежат внутри `image_prompts`).
- Ошибка одного слота не роняет весь batch; semantic QA и gate — fail-open.
- `IMAGE_PIPELINE_SEMANTIC_QA_FALLBACK=warn_only|hard_fail` — конфигурируемое
  поведение при падении semantic QA.

---

## Тесты

```bash
node backend/scripts/test-images-pipeline.js   # 22/22 (детерминированно, без сети)
```
