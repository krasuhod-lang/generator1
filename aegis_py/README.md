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
| `POST /ga4/fetch` | GA4 Reporting | `google-analytics-data` |
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

С Neo4j/Qdrant/Ray/DSPy/GA4 (большой образ, ~2 ГБ):
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
| `AEGIS_GA4_PROPERTY_ID` | GA4 property id |
| `GOOGLE_APPLICATION_CREDENTIALS` или `AEGIS_GA4_SA_JSON` | креды GA4 |
| `GOOGLE_API_KEY` или `GEMINI_API_KEY` | для эмбеддингов Qdrant |
| `DEEPSEEK_API_KEY` | mutator |
| `LOG_LEVEL` | INFO / DEBUG |

Подробная инструкция по подключению — `../AEGIS_SETUP.md`.
