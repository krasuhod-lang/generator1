# gist_py — GIST + LinguaForensic DSPy Pipeline

Микросервис генерации SEO-контента по логике GIST:
- находит семантические пробелы в выдаче (information_delta);
- снимает релевантность и AIO/LLM-потенциал запросов (GSC CSV / кластеры);
- генерирует контент как добавленную смысловую ценность, а не рерайт ТОПа;
- прогоняет текст через LinguaForensic v3.6 и при необходимости рерайтит;
- работает через DSPy как набор модулей с переиспользуемыми промптами
  (graceful-фолбэк: без `dspy-ai` те же промпты идут напрямую в LLM API).

## Архитектура

```
Query / GSC CSV
   ↓
M0 Relevance Scanner      app/modules/m0_relevance.py   (regex + G0-FORMAT)
M1 Competitor Scraper     app/modules/m1_scraper.py     (Serper/SerpAPI + BS4)
M2 Noise Extractor (G1)   app/modules/m2_noise.py       (claims + dedup 0.85)
M3 Gap Finder (G2)        app/modules/m3_gap.py         (delta + GIST Score)
M4 Content Architect      app/modules/m4_architect.py   (40/60, AIO-snippets)
M5 Persona Generator      app/modules/m5_persona.py
M6 Content Generator (G3) app/modules/m6_generator.py   (интро/база/эксперт)
M7 Redundancy Checker     app/modules/m7_redundancy.py
M8 LinguaForensic         app/modules/m8_detector.py    (skill AI-detect-v-3-6.md)
M9 Fluency Rewriter       app/modules/m9_rewriter.py    (F1–F7, цикл ≤3)
M10 SEO Formatter         app/modules/m10_formatter.py  (AIO, LSI, Schema.org)
   ↓
Output: final content + meta + schema + scores
```

Оркестрация: `app/pipeline.py` (`GistPipeline.run`), stop-criteria:
GIST Score ≥ 30%, robotness ≤ 25%, ≤ 3 рерайтов, сохранён AIO-формат и LSI.

## API

| Метод | Путь                  | Описание                                    |
|-------|-----------------------|---------------------------------------------|
| GET   | `/health`             | healthcheck                                  |
| POST  | `/relevance/scan`     | M0 для массива ключей `{"queries": [...]}`  |
| POST  | `/relevance/scan-csv` | M0 для CSV из GSC (multipart `file`)        |
| POST  | `/pipeline/run`       | полный пайплайн `{"query", "target_audience", "domain", "task_id"}` |

Аутентификация: заголовок `X-Internal-Token` (env `GIST_INTERNAL_TOKEN`).

## Переменные окружения

| Переменная | Назначение |
|---|---|
| `SERPER_API_KEY` / `SERPAPI_API_KEY` | SERP-провайдер (M1) |
| `GIST_LLM_API_BASE`, `GIST_LLM_API_KEY`, `GIST_LLM_MODEL` | LLM (OpenAI-совместимый API) |
| `GIST_EMBED_API_BASE`, `GIST_EMBED_API_KEY`, `GIST_EMBED_MODEL` | embeddings (`text-embedding-3-small`) |
| `GIST_LINGUAFORENSIC_SKILL` | путь к `AI-detect-v-3-6.md` (system prompt детектора) |
| `DATABASE_URL` | прямой персист метрик в `article_tasks` (нужен psycopg2) |
| `RELEVANCE_HEADLESS_FETCHER_URL` | Playwright-фолбэк рендера JS-страниц |
| `GIST_*` пороги | см. `app/config.py` (dedup 0.85, GIST min 30, robotness stop 25 и т.д.) |

> **Важно:** файл `AI-detect-v-3-6.md` (skill LinguaForensic v3.6) не хранится
> в репозитории — положите его рядом и укажите путь в
> `GIST_LINGUAFORENSIC_SKILL`. Без него детектор работает в упрощённом режиме.

## БД

Миграция `migrations/113_gist_pipeline.sql` создаёт таблицу `article_tasks`
со всеми полями §14 ТЗ (top10_claims_json, information_delta_json, gist_score,
robotness_score, pipeline_stage, …). Если `DATABASE_URL` не задан, метрики
возвращаются в ответе API и персистятся Node-бэкендом.

## Тесты

```bash
cd gist_py
pip install -r requirements.txt
python -m pytest
```

Тестами покрыты детерминированные части: regex-группы M0, парсинг GSC CSV,
очистка HTML и стоп-лист M1, дедупликация claims, GIST Score, пороги
robotness/стратегий, ограничение объёма рерайта ±15%, AIO-аудит, LSI-покрытие,
полная оркестрация с циклом рерайта (на фейковом LLM).

## Docker

```bash
docker compose up -d gist            # лёгкая сборка
docker compose build --build-arg INSTALL_HEAVY=true gist   # + dspy-ai, embeddings, psycopg2
```
