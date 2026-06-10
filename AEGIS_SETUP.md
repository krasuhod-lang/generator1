# A.E.G.I.S. — пошаговая инструкция подключения

> **A.E.G.I.S.** (Адаптивный Эвристический Генеративно-Интеллектуальный Сервис, «Эгида») — мозг системы поверх существующих 9 SEO-модулей.  
> Включается **постепенно** (Phase 0 → 13). Каждая фаза опциональна, остальные модули продолжают работать.

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
| **9 — Observability & FinOps** | метрики Prometheus + alerting Telegram/Slack + Kill Switch | **Prometheus/Grafana** (опц.), **Telegram bot** / **Slack webhook** (опц.) | `AEGIS_TELEMETRY_ENABLED=true`, `AEGIS_ALERTING_ENABLED=true` |
| **10 — Context Compression** | LLMLingua-style сжатие промптов | — (внутри) | `AEGIS_COMPRESS_ENABLED=true` |
| **11 — Backups** | ночные снапшоты Qdrant/Neo4j → S3 | **S3-совместимый bucket** (опц.; иначе локально) | `AEGIS_BACKUP_ENABLED=true`, `AEGIS_BACKUP_S3_BUCKET` |
| **12 — LLM Routing/Fallback** | circuit-breaker + переключение на vLLM/Llama3 | **vLLM** (опц., локальный) | `AEGIS_ROUTING_ENABLED=true`, `AEGIS_VLLM_URL` |
| **13 — Data Poisoning Filter** | фильтр перед записью в Qdrant | — (внутри) | `AEGIS_POISON_ENABLED=true` (по умолчанию ВКЛ) |
| — | GitHub backlog | GitHub PAT | `AEGIS_GITHUB_REPO`, `AEGIS_GITHUB_PAT` |

> 🛡️ **Жёсткий гейт качества: Spq ≥ 8.0** (= overall ≥ 80 по шкале 0..100) — по требованию владельца продукта.  
> 🧠 **Self-Mutation** использует **DeepSeek-V4-Pro**, а **не Claude** — по требованию владельца продукта.  
> 🔑 **Все эмбеддинги** идут через Gemini API (используем уже существующий ключ `GOOGLE_API_KEY` / `GEMINI_API_KEY`).
> 🆘 **Kill Switch** доступен всегда: `POST /api/aegis/kill` с body `{"action":"engage","reason":"…"}` от админа — мгновенно останавливает все LLM-вызовы и Ray-задачи.

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

### Если мозг застрял в `1baseline (ещё не обучен)` — чек-лист
Симптомы (см. дашборд `🛡️ A.E.G.I.S.`): «Версия: 1baseline», `Trials DSPy: 0`,
`Mean Spq до/после: — → —`, в Prompts-as-Code нет записей с DSPy-recompile.

1. **DSPy выключен флагом.** Убедитесь, что в env прода стоит
   `AEGIS_DSPY_ENABLED=true`. По умолчанию `false` — autopilot
   (`dspyAutoRetrain.tick`) и weekly workflow тихо выходят с
   `last_retrain_reason='dspy_disabled'`.
2. **Заданы все три DSPy env'а:** `AEGIS_DSPY_PY_URL` (URL `aegis_py`),
   `AEGIS_DSPY_MAX_TRIALS`, `AEGIS_DSPY_MAX_COST_USD`,
   `AEGIS_DSPY_MIN_IMPROVEMENT_PCT`.
3. **GitHub-секреты для weekly workflow:** `AEGIS_API_URL`,
   `AEGIS_API_TOKEN`, `AEGIS_PY_URL`. Без них шаг `Trigger retrain`
   делает `exit 0` без логов.
4. **Дёрните retrain руками:**
   ```bash
   curl -X POST "$AEGIS_API_URL/aegis/dspy/retrain" \
     -H "Authorization: ******" \
     -H "Content-Type: application/json" \
     -d '{"dry_run": false}'
   ```
   Проверьте: в `aegis_brain_versions` появилась запись с `deployed_at`,
   `brain_state/compiled_writer.yaml` обновился (не `617 B` baseline-стаб).
5. После первого успешного retrain автопилот сам подхватит расписание
   (`autoRetrainCheckIntervalSec=3600`, не чаще раза в 6 часов при
   ≥10 строк в `aegis_dspy_dataset`).

### Если карточка «🧪 Эксперименты мозга» висит в `planned`
Эксперименты застревают в статусе `planned`/`dispatched` и
`uq_aegis_experiments_open`-индекс не даёт мозгу выбрать те же URL снова —
поэтому кнопка «Запустить тик сейчас» возвращает `Кандидатов: 0`.

С версии этого PR:
- `featureFlags.experiments.autoDispatch=true` по умолчанию — `runOnce()`
  сразу переводит `planned → dispatched`, чтобы пошёл `measureAfterDays`-таймер.
- Добавлен `closeStaleExperiments()` (TTL = `measureAfterDays + staleGraceDays`,
  по умолчанию 14+7=21 день) — закрывает зависшие записи как
  `outcome='inconclusive'`, освобождая URL для повторного выбора.
- Sweep вызывается на старте каждого `runOnce()` и отдельным таймером
  раз в час из `startExperimentLoop`.
- `/api/aegis/experiments/run` теперь возвращает `stale_closed` и
  `in_progress: { planned, dispatched }`. UI показывает «в работе:
  planned=N, dispatched=M — все URL заняты», если `picked=0` из-за
  дедупликации.

Если хочется создавать GitHub-issue на каждый эксперимент — поднимите
`featureFlags.experiments.dispatchToBacklog=true` и настройте
`AEGIS_GITHUB_PAT` + `AEGIS_GITHUB_REPO` (см. блок «GitHub Backlog» ниже).

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
| `GET /api/aegis/metrics` | Prometheus-метрики (Phase 9, no auth) |
| `GET /api/aegis/kill` | Состояние Kill Switch + spend rate + breakers (Phase 9) |
| `POST /api/aegis/kill` | Engage/disengage Kill Switch (admin, Phase 9) |
| `GET /api/aegis/finops/spend` | Rolling spend USD/h (Phase 9) |
| `GET /api/aegis/router/breakers` | Состояние circuit-breakers по провайдерам (Phase 12) |
| `POST /api/aegis/backup/run` | Триггер снапшота Qdrant+Neo4j → S3 (admin, Phase 11) |
| `GET /api/aegis/backup/list` | Список локальных снапшотов (Phase 11) |

---

## Phase 9 — Observability & FinOps

Реализует все 4 требования из задачи: **OpenTelemetry+Grafana**, **Alerting System**, **глобальный «красный рычаг»**, прозрачность 150+ параллельных потоков.

### 9.1 Метрики Prometheus

```bash
# .env
AEGIS_TELEMETRY_ENABLED=true            # default уже true
# опц. push в OTLP-коллектор (если поднимаете OpenTelemetry Collector):
AEGIS_OTLP_HTTP_URL=http://otel-collector:4318/v1/metrics
AEGIS_TELEMETRY_PUSH_INTERVAL_SEC=60
```

**Экспонируемые метрики** (`GET /api/aegis/metrics`, text/plain exposition v0.0.4):

| Имя | Тип | Labels |
|---|---|---|
| `aegis_tokens_total` | counter | `provider`, `direction=in\|out` |
| `aegis_cost_usd_total` | counter | `provider` |
| `aegis_cache_hits_total` / `aegis_cache_misses_total` | counter | `provider` |
| `aegis_llm_requests_total` | counter | `provider`, `outcome=ok\|error` |
| `aegis_llm_latency_ms` | histogram (10/50/100/250/500/1k/2.5k/5k/10k/30k ms) | `provider` |
| `aegis_workers_active` | gauge | — (для Ray workers) |
| `aegis_killswitch` | gauge | 1=engaged |
| `aegis_quality_score` | gauge | `kind` |
| `aegis_spend_rate_usd_per_hour` | gauge | — (computed on scrape) |

### Подключение Prometheus + Grafana (опционально)

```yaml
# prometheus.yml
scrape_configs:
  - job_name: aegis
    metrics_path: /api/aegis/metrics
    scheme: https
    static_configs:
      - targets: ['your-backend-host:443']
```

Grafana dashboard — минимальный набор panel-ов:
- **TPS**: `rate(aegis_tokens_total[1m])` by `(provider, direction)` — токены в секунду.
- **Стоимость $/час**: `aegis_spend_rate_usd_per_hour`.
- **Cache hit rate**: `rate(aegis_cache_hits_total[5m]) / (rate(aegis_cache_hits_total[5m]) + rate(aegis_cache_misses_total[5m]))` by `(provider)`.
- **p95 latency**: `histogram_quantile(0.95, rate(aegis_llm_latency_ms_bucket[5m]))` by `(provider)`.
- **Workers**: `aegis_workers_active`.

> 💡 **Если не хочется поднимать Prometheus** — `/api/aegis/metrics` работает «как есть». Можно один раз в минуту вызывать его из любой системы мониторинга (Zabbix, Datadog Agent, Uptime Kuma, простой `curl` + `prom2json`).

### 9.2 Alerting (Telegram + Slack + auto-stop)

```bash
# .env
AEGIS_ALERTING_ENABLED=true
AEGIS_ALERT_RATE_USD_PER_HOUR=50       # потолок расхода
AEGIS_ALERT_WINDOW_SEC=600             # rolling-окно для расчёта rate
AEGIS_ALERT_AUTO_KILL=true             # при пробое — engage стоп-флаг автоматически
AEGIS_ALERT_COOLDOWN_SEC=300

# Каналы доставки — любой опциональный (graceful):
AEGIS_ALERT_TG_TOKEN=1234567890:ABCDEF
AEGIS_ALERT_TG_CHAT=-1001234567890
AEGIS_ALERT_SLACK_URL=https://hooks.slack.com/services/your/url/here
```

Бот для Telegram создаётся у `@BotFather`. Slack webhook — в `Apps → Incoming Webhooks`. Если ни один канал не настроен, алерты пишутся в `console.warn` и в БД `aegis_alerts`.

**Что вызывает алерт:**
- spend-rate > `rateUsdPerHour` за `rollingWindowSec` ⇒ severity=critical.
- Все провайдеры LLM-роутера упали (Phase 12) ⇒ severity=critical.
- Любой ручной/авто-engage стоп-флага ⇒ severity=critical/info.

### 9.3 Глобальный стоп-флаг — экстренная остановка

```bash
# Через API (от админа):
curl -X POST https://your-backend/api/aegis/kill \
  -H "Authorization: Bearer <admin_jwt>" \
  -H "Content-Type: application/json" \
  -d '{"action":"engage","reason":"stuck loop in scraper"}'

# Снять блок:
curl -X POST https://your-backend/api/aegis/kill \
  -H "Authorization: Bearer <admin_jwt>" \
  -d '{"action":"disengage"}'

# Посмотреть состояние:
curl -H "Authorization: Bearer <admin_jwt>" https://your-backend/api/aegis/kill
```

Поведение при engaged=true:
- `llmRouter.route()` сразу возвращает `{ok:false, reason:'killswitch'}` — нулевой расход.
- `rayClient.submit()` отдаёт ту же ошибку (новые actors не запускаются).
- Orchestrator не запускает следующие итерации refine.
- Состояние persist'ится в `aegis_killswitch` — выживает рестарт сервера.

---

## Phase 10 — Context Compression (LLMLingua-style, внутри)

Когда Neo4j-подграф или GraphRAG-контекст превышает токен-лимит модели (или просто становится дорогим даже с кэшем), `promptCompressor.compressPrompt(text, opts)` применяет **детерминированное extractive сжатие**:

1. Разбивает на предложения.
2. Считает IDF по корпусу предложений.
3. Скорит каждое: `+2·log(1+|numerics|) + 1.5·|proper_nouns| + Σ IDF + 5·header_bonus − 0.01·len_chars`.
4. Сохраняет топ `keepTopRatio` (по умолчанию 40%) всегда, плюс жадно добирает по бюджету `targetTokens`.

**Гарантии:**
- Числа, проценты, даты, валюты — всегда сохраняются (высокий numeric-bonus).
- Имена собственные (Capitalized) — приоритет.
- Стоп-слова RU/EN — игнорируются в score.

```bash
AEGIS_COMPRESS_ENABLED=true
AEGIS_COMPRESS_TARGET_TOKENS=24000
AEGIS_COMPRESS_MIN_TOKENS=4000      # короче — не трогаем
AEGIS_COMPRESS_KEEP_TOP_RATIO=0.4
```

> 🧪 Тест `node backend/scripts/test-aegis-phase9-13.js` проверяет, что после сжатия (target=500 tok из ~50k) числовые факты «89.5 млрд», «146 млн», «2018 год» всегда выживают.

> 🔌 **Подключение внешнего LLMLingua-сервиса не требуется** — всё внутри, на чистом JS, детерминированно, нулевая зависимость и нулевая стоимость на токен.

---

## Phase 11 — Backups (Qdrant + Neo4j → S3)

```bash
AEGIS_BACKUP_ENABLED=true
AEGIS_BACKUP_S3_BUCKET=my-aegis-backups       # опц. — без него лежит локально
AEGIS_BACKUP_S3_REGION=eu-central-1
AEGIS_BACKUP_S3_PREFIX=aegis/backups
AEGIS_BACKUP_RETAIN_DAYS=30
AEGIS_BACKUP_LOCAL_DIR=/var/lib/aegis/backups
```

### Что бэкапится

- **Qdrant**: per-collection snapshot через нативный API (`POST /collections/{name}/snapshots` + GET).
- **Neo4j**: APOC `apoc.export.cypher.all(…)` — полный CYPHER-дамп. Если APOC не установлен — fallback на schema-only (даём предупреждение).
- **brain_state**: уже в git ⇒ бэкапится репозиторием (не дублируем).

### Запуск

Автоматически — каждую ночь через GitHub Actions:

```
.github/workflows/aegis-nightly-backup.yml — уже в репо.
Нужные secrets в репо:
  AEGIS_BACKEND_URL  — https://your-backend
  AEGIS_ADMIN_TOKEN  — JWT админа
```

Вручную:

```bash
curl -X POST https://your-backend/api/aegis/backup/run \
  -H "Authorization: Bearer <admin_jwt>" \
  -d '{"targets":["qdrant","neo4j"]}'
```

### S3 опционален

Без `AEGIS_BACKUP_S3_BUCKET` снапшоты складываются в `AEGIS_BACKUP_LOCAL_DIR` (примонтируйте volume в docker'е). Дальше — любой `aws s3 sync` / `rclone` cron'ом, или ничего, если хватает локального диска.

Зависимости (опц., в `aegis_py`):
```
pip install boto3 neo4j httpx
```
Без них модуль возвращает `status: skipped` с причиной — пайплайн не падает.

---

## Phase 12 — LLM Routing & Fallback (vLLM/Llama3)

```bash
AEGIS_ROUTING_ENABLED=true
AEGIS_ROUTING_CRITIC_CHAIN=deepseek,gemini,vllm
AEGIS_ROUTING_WRITER_CHAIN=gemini,deepseek,vllm
AEGIS_CB_FAIL_THRESHOLD=5
AEGIS_CB_OPEN_SEC=60
AEGIS_CB_HALF_OPEN_PROBES=2

# Опц.: локальная vLLM как полностью офлайн-fallback
AEGIS_VLLM_URL=http://vllm:8000           # OpenAI-compatible endpoint
AEGIS_VLLM_MODEL=meta-llama/Llama-3-70B-Instruct
```

**Логика:**
1. Перед вызовом — проверка стоп-флага ⇒ если включён, `reason:'killswitch'`, без сети.
2. Идём по `chain` слева направо. Если у провайдера circuit-breaker `OPEN` — пропускаем.
3. Если получили 429/502/timeout (см. `retryOnStatus`) — фейл, увеличиваем counter; после 5 подряд — circuit `OPEN` на 60 сек, потом 2 probe-запроса в `HALF_OPEN`.
4. Если первый провайдер дал ошибку — следующий из цепочки.
5. Если **все** провалились — `alerting.sendAlert(critical)`.

### Поднять vLLM локально (опц.)

Если нужен 100% офлайн-fallback (когда упали и DeepSeek, и Gemini):
```bash
docker run --gpus all -p 8000:8000 vllm/vllm-openai:latest \
  --model meta-llama/Llama-3-70B-Instruct \
  --download-dir /models
```
Затем `AEGIS_VLLM_URL=http://localhost:8000`. Стоимость в `aegis_cost_usd_total` для `provider="vllm"` будет 0 (бесплатно — только электричество).

> 💡 **vLLM можно не поднимать** — fallback'а на Gemini ↔ DeepSeek уже хватает в 99% случаев. vLLM нужен только для редчайшего сценария «обе облачные API лежат одновременно».

---

## Phase 13 — Data Poisoning Filter

Защита от того, что конкуренты прячут на своих страницах мусор для запутывания LLM. Включён по умолчанию (`AEGIS_POISON_ENABLED=true`), запускается перед записью в Qdrant.

```bash
AEGIS_POISON_HIDDEN_MAX_RATIO=0.05      # > 5% скрытого текста → блок
AEGIS_POISON_NGRAM_MAX_REPEAT=8         # 3-gram повторов больше — стаффинг
AEGIS_POISON_INVISIBLE_MAX_RATIO=0.01   # ZWSP/RLO и пр.
AEGIS_POISON_NUMERIC_OUTLIER_X=5.0      # значение > 5× медианы → выброс
AEGIS_POISON_ON_FAIL=drop               # drop | mark
```

**Что детектится:**
| Категория | Метод |
|---|---|
| Скрытый текст | inline-style `display:none\|visibility:hidden\|opacity:0\|font-size:0\|text-indent:-9999px`, атрибут `hidden`, `aria-hidden="true"` |
| Keyword stuffing | n-gram (3-gram) повторов больше `keywordStuffMaxRepeat` |
| Невидимый Unicode | ZWSP (U+200B), ZWNJ, ZWJ, LRM/RLM, bidi overrides (U+202A-E), soft hyphen, BOM |
| Числовые выбросы | значение вне `[median/X .. median·X]` (X=5 по умолчанию) — по нише |

При `onFail=drop` блок не пишется в Qdrant. При `mark` — пишется с `meta.poisoned=true` для дальнейшего исключения из контекста.

> 🔌 **Внешний сервис не нужен.** Всё внутри, чистый JS, детерминированно, нулевой cost. Защищает Этап 0 рецепторов от data-poisoning атак.

---

## 🧠 Процесс самообучения A.E.G.I.S. — как всё закольцовано

Самообучение системы — это **полный цикл от продакшен-данных к новому промпту/коду без участия человека**. Состоит из 6 петель, замкнутых через `brain_state/`, БД и DeepSeek-V4-Pro:

### Петля 1 — Каждая статья → датасет
1. **Writer** (Phase 5: LangGraph + Gemini/DeepSeek) генерирует статью.
2. **Critics** (Phase 3: factCheck / plagiarism / readability / intentVerify / LSI-overdose / EEAT) ставят оценки.
3. **`computeQualityScore`** агрегирует в Spq overall ∈ [0..100] + sub-scores.
4. **Гейт** (`qualityGate.minOverall=80`): если ниже — **Phase 5 refine loop** запускает рефайнер до `langgraph.maxRefineIters` (3 по умолчанию).
5. Финальный pair `(user_prompt, html_output, quality_score)` пишется в `aegis_dspy_dataset`.

### Петля 2 — Каждый клик в GA4 → PPO-вес (Phase 7)
1. Раз в сутки `aegis_py/app/ga4.py` тянет CTR/dwell/scroll per-URL из GA4.
2. `computePpoWeights` присваивает топ-25% статей `ppo_weight=3`, остальным `1`.
3. Вес попадает в `aegis_dspy_dataset.ppo_weight` — будущий retrain «больше учится» на победителях.

### Петля 3 — Еженедельный retrain мозга (Phase 6, DSPy MIPROv2)
1. По cron'у admin триггерит `POST /api/aegis/dspy/retrain`.
2. `aegis_py/app/dspy_optimizer.py` берёт датасет (взвешенный по PPO), запускает MIPROv2 ≤ `AEGIS_DSPY_MAX_TRIALS` trials c бюджетом ≤ `AEGIS_DSPY_MAX_COST_USD`.
3. Если новый `mean_spq_after − mean_spq_before ≥ AEGIS_DSPY_MIN_IMPROVEMENT_PCT` — `compiled_writer.yaml`/`compiled_critic.yaml` обновляются в `brain_state/` и коммитятся в git.
4. Версия пишется в `aegis_brain_versions` — можно откатить.

### Петля 4 — Self-mutation парсера (Phase 8, DeepSeek-V4-Pro)
1. Receptor-парсер (Этап 0) падает ≥ `AEGIS_SELFMUTATE_FAIL_TRIGGER` раз подряд на домене.
2. `aegis_py/app/mutator.py` шлёт DOM-снимок + старый код в DeepSeek-V4-Pro.
3. DeepSeek возвращает unified-diff. Логируется в `aegis_mutations`.
4. **Если `requireHumanReview=true` (рекомендуем)** — `githubBot.createPullRequest` создаёт draft PR. Человек смотрит и мерджит.
5. **При false** — bot мерджит сразу (только для путей в `allowlist` парсеров).

### Петля 5 — Observability → Alerting → стоп-флаг (Phase 9)
1. Каждый LLM-вызов → `telemetry.recordLlmCall(...)` + `alerting.recordSpend(...)`.
2. Если rolling rate > `AEGIS_ALERT_RATE_USD_PER_HOUR` — Telegram/Slack-алерт.
3. Если `AEGIS_ALERT_AUTO_KILL=true` — стоп-флаг активируется автоматически. Бюджет защищён.

### Петля 6 — GitHub Issues как глобальный backlog
1. `aegis_runs` помеченные `verdict=review` или `needs_human_review=true` периодически экспортируются в GitHub Issues (label `aegis:ready`).
2. Любая идея/баг/мутация — единая точка входа для оператора.

### Схема (текстовая)

```
              ┌────────────────────────────────────────────────────────┐
              │                  ПРОДАКШЕН (рантайм)                   │
              │                                                        │
   user task →│  Receptor → Stage1-9 → Writer ⇄ Critics ⇄ Refiner →  │→ публикация
              │                              │                          │
              │           Phase 13 ─────────┘ (poison filter)           │
              │            Phase 10 ──────── (compress prompt)          │
              │            Phase 12 ──────── (LLM routing fallback)     │
              │            Phase 9  ──────── (metrics+alerting+стоп)    │
              └────────────┬───────────────────────────────────────────┘
                           │ tokens, cost, Spq, audit, html
                           ▼
                ┌──────────────────────┐         ┌──────────────────────┐
                │   aegis_dspy_dataset │         │ GA4 metrics (раз/сут)│
                │  (Spq, prompt, html) │◄────────│  CTR / dwell / scroll│
                └──────────┬───────────┘ PPO_w   └──────────────────────┘
                           │
            (раз в неделю) ▼
                ┌──────────────────────┐
                │   DSPy MIPROv2       │  ── улучшает Spq ≥ X% ─►  brain_state/*.yaml  ──► git commit
                │   weekly retrain     │                                │
                └──────────────────────┘                                │
                                                                       ▼
              ┌──────────────────────────────────────────────────────────┐
              │   Следующий цикл генерации использует новый prompt      │
              └──────────────────────────────────────────────────────────┘

   Параллельно:
       Scraper падает 5 раз → DeepSeek-V4-Pro → diff → GitHub draft PR → human review → merge
       Backups → 03:00 UTC: Qdrant snapshot + Neo4j dump → S3 (опц.)
```

---

## 🔌 Что подключать снаружи vs что реализовано внутри

| Возможность | Реализовано внутри | Внешний сервис (опц.) | Что даёт внешний |
|---|---|---|---|
| **Гейт качества + Spq** | ✅ `qualityGate.js` | — | — |
| **Бюджет per-task** | ✅ `budgetGuard.js` | — | — |
| **Метрики Prom-format** | ✅ `telemetry.js` + endpoint `/metrics` | **Prometheus + Grafana** | дашборды, retention, query language |
| **OTLP push** | ✅ HTTP-клиент к коллектору | **OpenTelemetry Collector** | агрегация в Jaeger/Tempo/etc |
| **Alerting** | ✅ Telegram/Slack/log/DB | **Telegram bot** или **Slack** webhook | реальные уведомления; иначе только console+DB |
| **Глобальный стоп-флаг** | ✅ DB-persisted | — | — |
| **Context compression** | ✅ `promptCompressor.js` (LLMLingua-style) | — | — |
| **GraphRAG (Neo4j)** | API-клиент | **Neo4j** | хранение онтологии |
| **VectorDB** | API-клиент | **Qdrant** | hybrid retrieval |
| **Parallel actors** | в `aegis_py/ray_runner.py` | **Ray cluster** | 150+ workers |
| **Writer→Critic→Refiner граф** | mini-LangGraph в Node | **aegis_py + LangGraph** | визуализация графа состояний |
| **Weekly retrain мозга** | API-клиент | **aegis_py + DSPy MIPROv2** | автоматическое улучшение промпта |
| **GA4 CTR feedback** | API-клиент | **GA4 service account** | реальный сигнал от пользователей |
| **Self-mutation парсера** | API-клиент к DeepSeek-V4-Pro | — (уже есть DeepSeek key) | — |
| **Backups** | client + `aegis_py/backup.py` | **S3-совместимый bucket** (опц.) | долговременное хранение; без S3 — на локальный volume |
| **LLM Routing/Fallback** | ✅ `llmRouter.js` + circuit-breaker | **vLLM** (опц.) | 100% офлайн-fallback (Llama 3 70B) |
| **Data poisoning filter** | ✅ `poisonFilter.js` (hidden/stuffing/invisible/outliers) | — | — |
| **Issue-driven backlog** | API-клиент | **GitHub PAT** | глобальный todo для оператора |

> **Принцип:** _везде, где можно — делаем внутри без зависимостей._  
> Внешние сервисы добавляются ТОЛЬКО там, где они дают качественный прыжок (хранение онтологии в Neo4j, ML-retrain через DSPy, реальный сигнал из GA4). Phase 9, 10, 12, 13 целиком работают «в одиночку» — никаких docker-стэков поднимать не нужно.
| `GET http://qdrant:6333/healthz` | Qdrant |
| `GET http://neo4j:7474/` | Neo4j browser |
| `GET http://ray-head:8265/` | Ray dashboard |

Дашборд фронта: **`/aegis`**.

---

## Чек-лист включения GA4 RL и Self-Mutation (Phase 16)

Эти подсистемы по умолчанию выключены (см. лента `/aegis` → ⛔). Чтобы их включить, добавьте переменные окружения в продакшен-окружение (НЕ в `.env.example` — он намеренно зафиксирован; вся новая конфигурация хранится в коде, см. `backend/src/services/aegis/featureFlags.js`).

### GA4 RL/PPO feedback (`📊 GA4 RL/PPO`)

| ENV | Значение | Комментарий |
| --- | --- | --- |
| `AEGIS_RL_GA4_ENABLED` | `true` | Главный гейт `rlGa4.enabled` |
| `AEGIS_GA4_PROPERTY_ID` | `properties/000000000` | GA4 Data API property |
| `AEGIS_GA4_SA_JSON` | JSON service account (одной строкой) | Доступ read-only к GA4 |

После выставления — перезапустить процесс. В `/api/aegis/status.rl_ga4.property_id_set` появится `true`.

### Self-Mutation (`🤖 Self-Mutation DeepSeek-V4-Pro`)

| ENV | Значение | Комментарий |
| --- | --- | --- |
| `AEGIS_SELFMUTATE_ENABLED` | `true` | Гейт `selfmutate.enabled` |
| `AEGIS_SELFMUTATE_REQUIRE_HUMAN_REVIEW` | `true` (по умолчанию) | Жёсткий human-review первой недели; снимать **только** после ревью первых 20 мутаций |

Если включить self-mutation без `requireHumanReview=true`, в логи попадёт предупреждение, но изменения промтов всё равно встанут в очередь ревью — это намеренная страховка.

### Автозапуски, для которых ENV не нужен (Phase 16)

- **DSPy auto-retrain** (`backend/src/services/aegis/dspyAutoRetrain.js`) — гейтится `featureFlags.dspy.autoRetrainEnabled` (по умолчанию `true`). Реальный запуск произойдёт, только если `dspy.enabled=true` И в `aegis_dspy_dataset` ≥ `autoRetrainMinRows` (10) И с последнего deploy прошло ≥ `autoRetrainMinSpacingSec` (6ч).
- **SEO Brain scheduler** (`backend/src/services/aegis/seoBrainScheduler.js`) — гейтится `featureFlags.seoBrain.autoAnalyzeEnabled` (по умолчанию `true`). Раз в сутки агрегирует `aegis_seo_observations` по site_key и пересобирает snapshot. Если нет наблюдений — тихо ничего не делает.
- **Prompts-as-Code audit** — теперь логирует причину провала. Смотреть `GET /api/aegis/status.prompt_audit.last_error` (поля `reason`: `table_missing`/`scan_empty`/`db_error`/`schema_mismatch`).
