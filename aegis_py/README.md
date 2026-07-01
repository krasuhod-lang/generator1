# aegis_py — A.E.G.I.S. Python microservice

FastAPI-сервис, реализующий все тяжёлые подсистемы A.E.G.I.S.:

| Endpoint | Подсистема | Heavy deps |
|---|---|---|
| `POST /graphrag/upsert` | Neo4j + NetworkX | `neo4j`, `networkx` |
| `POST /graphrag/retrieve_lsi` | Betweenness Centrality | — |
| `POST /vectordb/index` | Qdrant (hybrid) | `qdrant-client` |
| `POST /vectordb/search` | Qdrant (hybrid) | `qdrant-client` |
| `POST /ray/submit` | Ray Cluster | `ray` |
| `GET  /ray/jobs/{id}` | — | — |
| `POST /langgraph/run` | LangGraph | `langgraph` |
| `POST /dspy/retrain` | DSPy MIPROv2 | `dspy-ai` |
| `GET  /dspy/status` | — | — |
| `POST /mutate/analyze` | DeepSeek-V4-Pro | — (только `requests`) |
| `POST /shannon` | Shannon entropy | — |
| `GET  /health` | — | — |

**Все тяжёлые deps — опциональны.** Сервис стартует и без них; не
готовые подсистемы возвращают `503 service_unavailable` с понятным
`reason`. Это позволяет постепенно подключать Phase 1 → Phase 7.

## Локально

```bash
cd aegis_py
pip install -r requirements.txt
pytest                      # smoke tests (без heavy deps)
uvicorn aegis_py.app.main:app --reload --port 8800
curl http://localhost:8800/health
```

## Docker

Без heavy deps (минимальный образ ~150 МБ):
```bash
docker build -t aegis-py .
docker run -p 8800:8800 aegis-py
```

С Neo4j/Qdrant/Ray/DSPy (большой образ, ~2 ГБ):
```bash
docker build --build-arg INSTALL_HEAVY=true -t aegis-py:full .
```

## Переменные окружения

| Env | Назначение |
|---|---|
| `AEGIS_NEO4J_URI` | `bolt://neo4j:7687` |
| `AEGIS_NEO4J_USER`, `AEGIS_NEO4J_PASSWORD` | креды Neo4j |
| `AEGIS_QDRANT_URL`, `AEGIS_QDRANT_API_KEY` | Qdrant endpoint |
| `RAY_ADDRESS` или `AEGIS_RAY_URL` | Ray cluster head |
| `GOOGLE_API_KEY` или `GEMINI_API_KEY` | для эмбеддингов Qdrant |
| `DEEPSEEK_API_KEY` | mutator |
| `LOG_LEVEL` | INFO / DEBUG |

Подробная инструкция по подключению — `../AEGIS_SETUP.md`.

## SEO Content Engine v2.0 (обёртки поверх пайплайна)

Четыре модуля в `app/seo_engine/` добавляются **поверх** существующих ~20 этапов
генерации, ничего в них не меняя (интеграции keys.so / xmlstock не трогаются):

| Модуль | Файл | Роль |
|---|---|---|
| 1. HybridScorer | `hybrid_scorer.py` | Cross-Engine скор: Яндекс (BM25 + LSI + анти-переспам) × Google (Entity coverage + Information Gain), гибрид `0.45*yandex + 0.55*google`, порог 8.0 |
| 2. DSPy Assertions | `drafting.py`, `text_utils.py` | Анти-галлюцинация (`fact_in_context`) + Zero-Fluff (`has_fluff`), offline-компиляция `.pkl` по `project_id` |
| 3. LangGraph State Machine | `pipeline.py` | `DataIngestion → EntityResearch → Structure → Drafting → CriticFactCheck → {finalize / retry(<2) / fallback}` |
| 4. DrMax E-E-A-T | `drmax.py` | `build_drmax_signals()` + промпты EntityResearch / Critic |

Heavy-зависимости опциональны: без `rank-bm25` работает встроенный BM25,
без `langgraph` — последовательный исполнитель с той же маршрутизацией, без
`dspy-ai` — недоступны только Assertions/компиляция. Статус — в `GET /health`
(ключ `seo_engine`).

**Эндпоинты:** `POST /seo/score`, `POST /seo/drmax`, `POST /seo/run`.

| Env | Назначение |
|---|---|
| `SEO_COMPILED_DIR` | каталог `.pkl` скомпилированных DSPy-программ (default `compiled_programs`) |
| `DEEPSEEK_API_KEY` | аналитика/критика/структура (DeepSeek v4) |
| `GOOGLE_API_KEY` | финальный райтинг (Gemini) |
