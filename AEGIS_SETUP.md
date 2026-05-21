# A.E.G.I.S. — пошаговая инструкция подключения

> **A.E.G.I.S.** (Адаптивный Эвристический Генеративно-Интеллектуальный Сервис, «Эгида») — мозг системы поверх существующих 9 SEO-модулей.  
> Включается **постепенно** (Phase 0 → 8). Каждая фаза опциональна, остальные модули продолжают работать.

---

## TL;DR — что подключить (по фазам)

| Phase | Что | Внешнее, что нужно поднять | Минимальные env |
|---|---|---|---|
| 0 — Foundation | гейт качества, бюджеты, Shannon-фильтр | — | `AEGIS_ENABLED=true` |
| 1 — GraphRAG | онтология ниши | **Neo4j** (docker) | `AEGIS_NEO4J_URI`, `AEGIS_NEO4J_PASSWORD`, `AEGIS_PY_URL` |
| 2 — VectorDB | hybrid retrieval | **Qdrant** (docker) | `AEGIS_QDRANT_URL`, `GOOGLE_API_KEY` |
| 3 — Critics loop | факт-чек/плагиат/читаемость/интент | уже есть в репо | `INFO_ARTICLE_FACTCHECK_ENABLED=true` и др. |
| 4 — Ray | 150+ параллельных actors | **Ray cluster** (docker) | `RAY_ADDRESS` |
| 5 — LangGraph | writer→critic→refiner | aegis_py | `AEGIS_LANGGRAPH_ENABLED=true` |
| 6 — DSPy | weekly retrain мозга | aegis_py + PostgreSQL | `AEGIS_DSPY_ENABLED=true` |
| 7 — RL/GA4 | PPO-веса по CTR | GA4 service account | `AEGIS_GA4_PROPERTY_ID`, `AEGIS_GA4_SA_JSON` |
| 8 — Self-Mutation | DeepSeek-V4-Pro чинит парсер | DeepSeek API key (уже есть) | `AEGIS_SELFMUTATE_ENABLED=true` |
| — | GitHub backlog | GitHub PAT | `AEGIS_GITHUB_REPO`, `AEGIS_GITHUB_PAT` |

> 🛡️ **Жёсткий гейт качества: Spq ≥ 8.0** (= overall ≥ 80 по шкале 0..100) — по требованию владельца продукта.  
> 🧠 **Self-Mutation** использует **DeepSeek-V4-Pro**, а **не Claude** — по требованию владельца продукта.  
> 🔑 **Все эмбеддинги** идут через Gemini API (используем уже существующий ключ `GOOGLE_API_KEY` / `GEMINI_API_KEY`).

---

## Phase 0 — Foundation (включить сразу)

Ничего не нужно поднимать, только включить флаг:

```bash
# .env (см. блок "A.E.G.I.S. («Эгида»)" внизу .env.example)
AEGIS_ENABLED=true

# Жёсткий гейт качества — по умолчанию 80 (= Spq 8.0). НЕ снижайте.
AEGIS_QUALITY_MIN_OVERALL=80
AEGIS_QUALITY_ON_FAIL=fail        # fail — отбрасывать; review — отдавать с пометкой

# Шеннон-фильтр мусора (Stage 0)
AEGIS_SHANNON_ENABLED=true

# Бюджет на одну задачу — защита от галлюцинаторного цикла
AEGIS_OVERALL_TASK_USD=8
```

**Проверка:** перейдите на `/aegis` (фронт). Должна открыться панель «🛡️ A.E.G.I.S. — мозг системы».  
API: `GET /api/aegis/status`.

**Запуск smoke-тестов:**
```bash
node backend/scripts/test-aegis.js     # 25 проверок
cd aegis_py && pytest                  # 14 проверок (Python)
```

---

## Phase 1 — GraphRAG (Neo4j)

### 1. Поднять Neo4j

Через готовый additive compose:
```bash
docker compose -f docker-compose.yml -f docker-compose.aegis.yml \
               --profile graphrag --profile aegis up -d neo4j aegis_py
```

Или вручную:
```bash
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/your_password \
  neo4j:5.25-community
```

### 2. Заполнить env
```bash
AEGIS_GRAPHRAG_ENABLED=true
AEGIS_NEO4J_URI=bolt://localhost:7687
AEGIS_NEO4J_USER=neo4j
AEGIS_NEO4J_PASSWORD=your_password
AEGIS_PY_URL=http://localhost:8800
```

### 3. Установить тяжёлые deps в aegis_py
```bash
docker compose -f docker-compose.aegis.yml build \
               --build-arg AEGIS_PY_INSTALL_HEAVY=true aegis_py
```
или локально:
```bash
pip install neo4j==5.25.0 networkx==3.4.2
```

### 4. Проверка
```bash
curl http://localhost:8800/graphrag/health
# {"ok": true, "reason": null}
```

---

## Phase 2 — VectorDB (Qdrant)

### 1. Qdrant
```bash
docker compose -f docker-compose.aegis.yml --profile vectordb up -d qdrant
# или
docker run -d -p 6333:6333 qdrant/qdrant:v1.12.4
```

### 2. Env
```bash
AEGIS_VECTORDB_ENABLED=true
AEGIS_QDRANT_URL=http://localhost:6333
AEGIS_EMBEDDER=gemini
# GOOGLE_API_KEY уже есть в основном .env
```

### 3. Deps
```bash
pip install qdrant-client==1.12.1 rank-bm25==0.2.2
```

> Эмбеддинги — Gemini `text-embedding-004` (бесплатно, входит в Free Tier). Никакого OpenAI ключа не нужно.

---

## Phase 3 — Critics loop (уже частично включён)

Скорее всего у вас уже включены (миграции 023–028):
```bash
INFO_ARTICLE_FACTCHECK_ENABLED=true
INFO_ARTICLE_PLAGIARISM_ENABLED=true
INFO_ARTICLE_READABILITY_ENABLED=true
INFO_ARTICLE_INTENT_VERIFY_ENABLED=true
INFO_ARTICLE_IMAGE_QA_ENABLED=true
INFO_ARTICLE_EEAT_CHUNKED=true
INFO_ARTICLE_GROUNDING_ENABLED=true     # SERP-evidence
```

A.E.G.I.S. использует их через `orchestrator.runRefineLoop` — никакого нового кода критиков не добавляется.

---

## Phase 4 — Ray Cluster

> ⚠️ Тяжёлая фаза: ~2 ГБ образ, ~2 ГБ RAM минимум. Подключайте после нагрузочного теста.

```bash
docker compose -f docker-compose.aegis.yml --profile ray up -d ray-head
```

```bash
AEGIS_RAY_ENABLED=true
RAY_ADDRESS=ray://localhost:6379
```

Dashboard: http://localhost:8265

---

## Phase 5 — LangGraph оркестратор

Реализован в `backend/src/services/aegis/orchestrator.js` (Node) и опционально `aegis_py/app/langgraph_runner.py` (Python).

```bash
AEGIS_LANGGRAPH_ENABLED=true
AEGIS_LANGGRAPH_MAX_REFINE=3
AEGIS_LANGGRAPH_TARGET_OVERALL=80
```

Интеграция с существующими пайплайнами (info-article / link-article):  
В соответствующих pipeline-файлах вместо одинокого `callLLM(...)` оборачиваем writer + critics в `runRefineLoop(...)`. Точка интеграции — `runWriter` функция. (Этот шаг сейчас оставлен **под ручное включение**: A.E.G.I.S. ядро готово, но не подменяет существующий writer автоматически, чтобы не сломать прод. Контрольный пример — `backend/scripts/test-aegis.js` test «orchestrator passes after first write».)

---

## Phase 6 — DSPy retrain

```bash
AEGIS_DSPY_ENABLED=true
pip install dspy-ai==2.5.41
```

Запускается:
- автоматически **каждое воскресенье 02:00 UTC** через `.github/workflows/aegis-dspy-retrain.yml`
- вручную: `POST /api/aegis/dspy/retrain` (admin)

### Что нужно настроить в GitHub
В Settings → Secrets:
- `AEGIS_API_URL` — публичный URL вашего бэкенда + `/api` (например `https://app.example.com/api`)
- `AEGIS_API_TOKEN` — JWT админ-пользователя (выдайте через админ-панель)
- `AEGIS_PY_URL` — URL aegis_py (например `https://aegis-py.internal:8800`)

---

## Phase 7 — RL / GA4 feedback loop

### 1. Создать service account в Google Cloud
1. https://console.cloud.google.com → IAM → Service Accounts → Create
2. Скачать JSON key
3. В GA4: Admin → Property Access → добавить email сервисного аккаунта с ролью Viewer

### 2. Env
```bash
AEGIS_RL_GA4_ENABLED=true
AEGIS_GA4_PROPERTY_ID=123456789
# Inline JSON (удобно для Heroku/Render):
AEGIS_GA4_SA_JSON={"type":"service_account",...}
# или путь к файлу:
GOOGLE_APPLICATION_CREDENTIALS=/secrets/ga4-sa.json
```

### 3. Deps
```bash
pip install google-analytics-data==0.18.16 google-auth==2.35.0
```

---

## Phase 8 — Self-Mutation (DeepSeek-V4-Pro)

> ⚠️ Самая «опасная» фаза. **Первую неделю обязательно** `AEGIS_SELFMUTATE_REQUIRE_HUMAN=true` (default) — все PR создаются как **draft** и требуют ручного approve.

```bash
AEGIS_SELFMUTATE_ENABLED=true
AEGIS_SELFMUTATE_REQUIRE_HUMAN=true
AEGIS_SELFMUTATE_FAIL_TRIGGER=5
DEEPSEEK_API_KEY=...    # уже есть в основном .env
DEEPSEEK_MODEL=deepseek-chat   # или deepseek-reasoner для V4-Pro
```

### Что включено по умолчанию (защита)
- **Allowlist путей** (только `backend/src/services/parser/**`, `relevance/**`, `aegis_py/app/scrapers/**`).
- **Blocklist** (никогда не трогаем): `backend/src/services/llm/`, `metrics/`, `aegis/`, `migrations/`, `brain_state/`, `.github/workflows/`.
- **Abort** если DeepSeek уверен <70 % или хочет тронуть запрещённый путь.
- **Draft-PR** обязательно (`AEGIS_SELFMUTATE_REQUIRE_HUMAN=true`).

### Workflow
`.github/workflows/aegis-selfmutation.yml` — слушает issues с label `aegis:selfmutate-trigger`, вызывает `/api/aegis/mutate/propose`, открывает draft PR.

---

## GitHub Backlog (Opportunity Hunter)

```bash
AEGIS_BACKLOG_ENABLED=true
AEGIS_GITHUB_REPO=owner/name
AEGIS_GITHUB_PAT=ghp_...      # PAT с правом `repo`
AEGIS_BACKLOG_LABEL=aegis:ready
```

Forecaster (Модуль 5) находит «white-space LSI кластеры» и через `POST /api/aegis/backlog` создаёт issue с label `aegis:ready`. Workflow `.github/workflows/aegis-backlog-runner.yml` каждые 30 минут забирает их в работу.

---

## Что вам нужно сделать руками (чек-лист)

- [ ] **PostgreSQL миграции** — после рестарта backend ensureSchema создаст таблицы 038–042 автоматически. Если нужны строгие миграции вручную — см. `migrations/038_*..042_*.sql`.
- [ ] **GitHub Secrets** для трёх workflow:
  - `AEGIS_API_URL`, `AEGIS_API_TOKEN`, `AEGIS_PY_URL`
- [ ] **Neo4j** (Phase 1) — поднять контейнер, заполнить `AEGIS_NEO4J_*`.
- [ ] **Qdrant** (Phase 2) — поднять контейнер, заполнить `AEGIS_QDRANT_URL`.
- [ ] **aegis_py** — `docker compose -f docker-compose.aegis.yml --profile aegis up -d aegis_py` (с `--build-arg AEGIS_PY_INSTALL_HEAVY=true` если нужны Phase 1/2/4/6/7).
- [ ] **GA4 service account** (Phase 7) — создать в Google Cloud + добавить в GA4 property.
- [ ] **GitHub PAT** для бэклога — `repo` scope.

После каждого Phase: проверка `GET /api/aegis/status` (фронт `/aegis`) — health всех подсистем должен стать 🟢.

---

## Откат

Любая фаза отключается одним env-флагом:
```bash
AEGIS_GRAPHRAG_ENABLED=false   # и т. д.
```

Полный kill-switch:
```bash
AEGIS_ENABLED=false
```

Откат веса мозга:
```bash
git log brain_state/compiled_writer.yaml
git checkout <good-sha> -- brain_state/compiled_writer.yaml
git commit -m "aegis: rollback brain to <sha>"
```

---

## Telemetry / мониторинг

| Endpoint | Что |
|---|---|
| `GET /api/aegis/status` | Здоровье всех подсистем |
| `GET /api/aegis/runs?limit=20` | Последние циклы рефайна |
| `GET /api/aegis/backlog` | Очередь работ |
| `GET /api/aegis/brain/versions` | История DSPy retrain'ов |
| `GET http://aegis_py:8800/health` | Здоровье Python-микросервиса |
| `GET http://qdrant:6333/healthz` | Qdrant |
| `GET http://neo4j:7474/` | Neo4j browser |
| `GET http://ray-head:8265/` | Ray dashboard |

Дашборд фронта: **`/aegis`**.
