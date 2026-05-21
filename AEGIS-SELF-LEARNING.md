# A.E.G.I.S. — процесс самообучения и интеграции сервисов

Этот документ описывает, **как «нейромозг» Aegis учится сам**, какие внешние сервисы для этого нужны, а какие задачи мы уже закрыли «внутри программы» без внешних SaaS.

---

## 1. Что такое самообучение Aegis

Aegis — это не статичный пайплайн, а **самосовершенствующийся контур** генерации SEO-контента. Каждая статья = одна итерация эволюции: мы измеряем её качество в реальном мире (GA4, выдача) и подкручиваем поведение генератора так, чтобы следующая партия была лучше.

Цикл работает в фоне без участия оператора и опирается на накопленный «опыт мозга» в Qdrant + Neo4j + Postgres.

---

## 2. Полный цикл самообучения (end-to-end)

### Этап 0 — Поглощение знаний (Knowledge Ingestion)
- **Рецепторы Этапа 0**: RAG-скрейпер собирает HTML конкурентов и доверенных источников (статистика, регуляторика, экспертные блоги).
- **Фильтр отравленных данных** (`backend/src/services/aegis/poisonFilter.js`) пресекает hidden-text / keyword-stuffing / невидимые юникод-символы → конкурент **не сможет «накормить»** нас бредовыми фактами.
- Чистый текст embed'ится и пишется в:
  - **Qdrant** — вектора + payload `{run_id, created_at, niche, source}` (Phase 14: payload теперь обязателен — без него Vector GC не сработает);
  - **Neo4j** — граф связей сущностей (GraphRAG);
  - **Postgres** — структурированные факты, расходы, прогоны.

### Этап 1 — Подготовка задачи
- Из бэклога / форм UI приходит ТЗ. Оркестратор формирует план статьи.
- `GraphRAG` достаёт релевантный подграф фактов из Neo4j (по топику + ТЗ).
- **Семантическое сжатие промпта** (`promptCompressor.js`) — если подграф + SERP-evidence превышают `compress.targetTokens` (24k по умолчанию), сжимаем TF-IDF алгоритмом, сохраняя префикс (system-инструкцию).

### Этап 2 — Writer (Gemini, mutated by ε-greedy)
- Базовый системный промпт берётся из `compiled_writer.yaml` (актуальный артефакт DSPy).
- **Phase 14 / ε-greedy** (`dspy_optimizer.py::should_mutate`): в **5–10 % случаев** к промпту добавляется мягкая мутация (см. `MUTATION_KINDS` — 10 шт.: `reorder_sections`, `denser_lists`, `shorter_intro`, `add_faq_block` и т. д.).
- Выбор мутации **детерминирован для недели и ниши** (`pick_mutation(seed_key=f"{niche}|{week_iso}")` → SHA-256), чтобы за неделю накопить статистически значимый GA4-сигнал для одной и той же мутации.
- Это защита от Mode Collapse: мозг **не залипает** на одном «удачном» шаблоне, а постоянно зондирует пространство решений.

### Этап 3 — Critics (DeepSeek + детерминированные пост-проверки)
Параллельно прогоняются:
- `factCheck.service.js` — сверка числовых утверждений с SERP-evidence;
- `plagiarism.service.js` — n-gram overlap с конкурентами;
- `readability.service.js` — Flesch-RU + пассив + бюрократизмы;
- `intentVerify.service.js` — соответствие интенту запроса;
- `lsiPipeline.measureLsiCoverageSemantic` — покрытие LSI-семантики;
- `eeatAudit/core.js` — E-E-A-T (chunked для длинных статей);
- `imageQa.service.js` — пост-чек изображений NanoBananaPro.

Все вердикты сворачиваются в **SPQ-overall** (`computeQualityScore` в `qualityLayers/qualityScore.js`).

### Этап 4 — Refiner loop (если SPQ < gate)
- Если `SPQ < 80` (порог из `featureFlags.qualityGate.minOverall`) — Refiner на DeepSeek получает аудит критиков и переписывает проблемные секции.
- Loop ограничен `maxIters` (по умолчанию 2) и **budget-guard'ом** (`budgetGuard.js` + глобальный `alerting.js`).

### Этап 5 — Запись в датасет обучения
- Если статья прошла гейт (SPQ ≥ 80) → строка идёт в **`aegis_dspy_dataset`**: `user_prompt`, `html_output`, `quality_score`, `spq_overall`, `niche`, `ppo_weight`, `is_seed=FALSE`.
- Если не прошла — записывается в `aegis_validation_failures` (для discovery, не для обучения).
- Параллельно `aegis_runs.status='success'` → **Vector GC** (`vectorGc.cleanupRun({runId})`) подчищает эфемерные точки в Qdrant (evidence_*, serp_*, relevance_*) — иначе через 3–6 месяцев HNSW замедлится.

### Этап 6 — Еженедельный retrain DSPy (cron)
- Workflow `aegis-dspy-retrain.yml` (воскресенье ночь) зовёт `POST /dspy/retrain`.
- **Phase 14 / Cold-Start**: если в `aegis_dspy_dataset` (с `is_seed=FALSE`) < `cold_start_min_rows` (10) — `merge_with_seeds()` подмешивает **12 эталонных TOP-1 статей** из `dspy_seed.py`. Это решает проблему «первого запуска» — оптимизатор всегда имеет с чего стартовать.
- MIPROv2 / BootstrapFewShot оптимизирует промпт → новый `compiled_writer.yaml`.
- Если **improvement_pct ≥ min_improvement_pct** — артефакт коммитится в Git (через `deepseekMutator`), создаётся PR с дельтой.

### Этап 7 — Обратная связь из реального мира (GA4)
- `forecaster` + GA4-коннектор замеряют траффик / позиции опубликованных статей.
- Хороший результат = повышенный `ppo_weight` для строки → MIPROv2 даёт этому примеру больший вес в следующем retrain.
- **ε-greedy мутация, которая выстрелила в GA4**, становится частью основного промпта → парадигма мозга меняется.

---

## 3. Защитные контуры (всё уже в коде)

| Угроза | Защита | Файл |
|---|---|---|
| Перерасход бюджета на одной задаче | `budgetGuard.js` per-task tracker | `backend/src/services/aegis/budgetGuard.js` |
| Глобальный перерасход (> 50 $/ч) | `alerting.js` + Telegram/Slack + Kill Switch | `backend/src/services/aegis/alerting.js`, `killSwitch.js` |
| Падение DeepSeek/Gemini | `llmRouter.js` — fallback на vLLM/Llama-70B | `backend/src/services/aegis/llmRouter.js` |
| Раздувание Qdrant | **Phase 14** Vector GC: TTL + per-run cleanup | `aegis_py/app/vector_gc.py`, `backend/src/services/aegis/vectorGc.js` |
| Холодный старт DSPy | **Phase 14** 12 seed-статей TOP-1 | `aegis_py/app/dspy_seed.py` |
| Mode Collapse | **Phase 14** ε-greedy 5–10 % мутаций | `aegis_py/app/dspy_optimizer.py::should_mutate` |
| Отравленные данные конкурентов | `poisonFilter.js` (hidden / stuffing / invisible / outliers) + Phase 14 hook в Relevance | `backend/src/services/aegis/poisonFilter.js`, `backend/src/services/relevance/aegisHooks.js` |
| Превышение контекстного окна | `promptCompressor.js` (TF-IDF, сохраняет префикс) | `backend/src/services/aegis/promptCompressor.js` |
| Потеря накопленного «опыта» | Ночные снапшоты Qdrant + Neo4j → S3 | `backend/src/services/aegis/backupClient.js`, `aegis-nightly-backup.yml` |
| Невидимость метрик | Prometheus exposition + Grafana | `GET /api/aegis/metrics` |

---

## 4. Что подключать снаружи vs что у нас «под капотом»

### 4.1. Обязательно внешние сервисы (без них Aegis не полноценен)

| Сервис | Зачем | Альтернатива |
|---|---|---|
| **Gemini 2.x API** | Writer (длинный контекст 200k+, нативный JSON-mode) | OpenAI GPT-4o (хуже на длинном RU) |
| **DeepSeek-V4 Chat API** | Refiner / Critics / Mutator (дёшево + быстро) | Qwen-Max через DashScope (уже есть адаптер `dashscope.adapter.js`) |
| **Qdrant** (self-hosted Docker или Cloud) | Векторная память | Weaviate / Milvus — но переписывать `vectordb.py` |
| **Neo4j AuraDB / self-hosted 5.x** | GraphRAG | Memgraph — но переписывать GraphRAG-обёртку |
| **PostgreSQL 15+** | Состояние, бэклог, датасеты, прогоны | — обязательно |
| **Redis** | rawStorage (горячий путь), per-user concurrency | — обязательно |
| **GA4 API** | Замер реального трафика → обратная связь обучения | Yandex.Metrika API (адаптер придётся писать) |

### 4.2. Рекомендуемые внешние сервисы (повышают надёжность, но не блокирующие)

| Сервис | Зачем | Если нет |
|---|---|---|
| **Prometheus + Grafana** | Дашборды TPS, нагрузка воркеров, % кэша | Экспозиция работает на `GET /api/aegis/metrics`, метрики в text-формате — можно скрейпить чем угодно или смотреть curl'ом |
| **Telegram / Slack webhook** | Алёрты перерасхода / Kill Switch | `alerting.js` graceful-no-op без webhook'а, метрики всё равно копятся |
| **AWS S3** (или MinIO self-hosted) | Ночные снапшоты Qdrant/Neo4j | Можно крутить локальный MinIO в docker-compose |
| **vLLM** + Llama-3 70B на своём GPU | Fallback router при падении DeepSeek/Gemini для критических задач | `llmRouter.js` пометит модель как unavailable и попробует следующую по приоритету; если все мертвы — задача упадёт с понятной причиной |
| **XMLStock / Keys.so** | SERP / частотности | Уже опциональны (`graceful skip`) |
| **Ray Cluster** | Распараллеливание 150+ потоков на нескольких машинах | На одной машине работает в локальном режиме (`ray.init()` без cluster) |

### 4.3. Что мы уже сделали «под капотом» (внешний сервис **не нужен**)

| Возможность | Где | Внешний эквивалент |
|---|---|---|
| Telemetry / Prometheus exposition | `aegis/telemetry.js` + `GET /api/aegis/metrics` | OpenTelemetry SDK |
| In-memory budget tracking + alerting | `budgetGuard.js`, `alerting.js` | Datadog / CloudWatch |
| Circuit breaker для LLM-провайдеров | `llmRouter.js` (`getBreakerStates()`) | Hystrix / Resilience4j |
| Семантическое сжатие промпта | `promptCompressor.js` | LLMLingua (микросервис) |
| Anti-data-poisoning | `poisonFilter.js` | Закрытые SaaS — нет аналогов |
| Vector DB GC | **Phase 14** `vector_gc.py` | Qdrant Cloud TTL — есть, но платно |
| DSPy cold-start seed | **Phase 14** `dspy_seed.py` | — нет внешнего, это особенность нашей предметки |
| ε-greedy эксплорация | **Phase 14** `dspy_optimizer.py::should_mutate` | RL frameworks (Ray RLlib) — overkill для нашего объёма |
| Per-user concurrency cap | `perUserConcurrency.js` (FIFO 2 in-flight) | API Gateway rate-limit |
| Kill Switch | `killSwitch.js` + `POST /api/aegis/kill` | PagerDuty + manual k8s scale-to-zero |
| Ночной бэкап Qdrant + Neo4j → S3 | `backupClient.js` + `aegis-nightly-backup.yml` | Velero |

---

## 5. Быстрый чек-лист «что включить, чтобы заработало»

### Минимальная конфигурация (single VPS + docker-compose)
1. **Postgres 15** + **Redis 7** — обязательно.
2. **Qdrant** docker (`qdrant/qdrant:latest`) — обязательно для GraphRAG.
3. **Neo4j 5.x** docker (Community) — обязательно для подграфов.
4. **API-ключи в `.env`** (НЕ менять `.env.example` — все новые env-параметры читаются через `featureFlags.js` с разумными дефолтами):
   - `GEMINI_API_KEY`
   - `DEEPSEEK_API_KEY`
   - (опц.) `DASHSCOPE_API_KEY`, `XMLSTOCK_LOGIN`/`PASSWORD`, `KEYSSO_API_KEY`
5. **Миграции** прогонятся автоматически на старте через `server.js::ensureSchema()` (включая Phase 14: `aegis_dspy_dataset.is_seed`, `aegis_dspy_runs`, `aegis_vector_gc_log`).
6. **GitHub Actions cron'ы** (если нужен retrain/backup/GC по расписанию):
   - `aegis-dspy-retrain.yml`
   - `aegis-nightly-backup.yml`
   - **Phase 14**: `aegis-nightly-vector-gc.yml` (03:15 UTC, после бэкапа)
   - Нужны secrets: `AEGIS_BACKEND_URL`, `AEGIS_ADMIN_TOKEN`.

### Желаемая (production)
- Telegram bot webhook → `ALERT_TELEGRAM_BOT_TOKEN` + `ALERT_TELEGRAM_CHAT_ID` (читается через `featureFlags.alerting`).
- S3 bucket (или MinIO) → `AEGIS_BACKUP_S3_BUCKET`.
- Grafana → scrape `https://<host>/api/aegis/metrics` (Prometheus format, no auth — limit на reverse-proxy).
- vLLM + Llama-3 70B на отдельной GPU-ноде → `LLM_ROUTER_FALLBACK_URL`.

---

## 6. Phase 14 — точечные настройки

Все Phase 14 флаги в `backend/src/services/aegis/featureFlags.js` → блоки `dspy`, `vectorGc`, `relevanceAegis`. По умолчанию **всё включено и безопасно**:

```
dspy.coldStartUseSeeds      = true   # подмешивать seed при < 10 реальных строк
dspy.coldStartMinRows       = 10
dspy.epsilonGreedyRate      = 0.07   # 7 % мутаций (в диапазоне [0, 0.20])
vectorGc.enabled            = true
vectorGc.ttlDays            = 30
vectorGc.perRunCleanup      = true   # чистим точки run_id при success
vectorGc.minAgeSafetyHours  = 24     # даже ttl=0 не удалит ничего < 24h
relevanceAegis.enabled              = true
relevanceAegis.poisonFilterFetched  = true   # фильтр в /relevance
relevanceAegis.compressDeepseekPrompt = false  # включить руками для гигантских отчётов
relevanceAegis.vectorGcOnDone       = true
relevanceAegis.telemetrySpans       = true
```

Все настройки изменяются **через env-переменные** (читаются один раз на старте, deepFreeze) — но менять `.env.example` нельзя (договорённость владельца продукта). Просто экспортируй переменную перед стартом приложения.

---

## 7. Куда смотреть в первую очередь, если «что-то пошло не так»

| Симптом | Куда смотреть |
|---|---|
| Aegis не учится — `compiled_writer.yaml` не обновляется | `GET /api/aegis/runs` + логи воркфлоу `aegis-dspy-retrain.yml`. Если `rows_real < 10` и `used_seeds=true` — мозг ещё на cold-start, нужны успешные прогоны. |
| Тексты стали однообразные | `GET /api/aegis/metrics` → `aegis_dspy_mutations_total` по `kind`. Если все нули — ε-greedy выключен (`dspy.epsilonGreedyRate=0`). |
| Qdrant раздулся | `POST /api/aegis/vector-gc/sweep` с `dry_run=true` → увидишь `points_deleted_total` сколько бы удалили. Потом без dry-run. |
| Релевантность даёт «бредовые» рекомендации | `aegis_relevance_poison_dropped_total` по `reason`. Если 0 — фильтр выключен или сайты чистые; если много — у конкурентов в нише массовый black-hat SEO, рекомендации могут быть смещены. |
| Перерасход бюджета | `GET /api/aegis/finops/spend` → `rate_usd_h`. Если > 50 — должен был сработать алёрт; проверь, заданы ли webhook'и. Срочно: `POST /api/aegis/kill` с `{engaged:true}`. |

---

## 8. Дальнейшие шаги (не вошло в Phase 14, на будущее)

- **A/B на уровне URL**: публиковать одну статью в двух версиях (с мутацией и без) на subdir/subdomain → точный замер мутации.
- **Bandit вместо ε-greedy**: Thompson Sampling / UCB1 поверх `aegis_dspy_runs` для более эффективной эксплорации.
- **Графический Brain-Inspector UI**: визуализация GraphRAG-подграфа, выбираемого для конкретной статьи.
- **Auto-PR на изменение `compiled_writer.yaml`** через DeepSeek-mutator (частично уже есть — `deepseekMutator.js`).
