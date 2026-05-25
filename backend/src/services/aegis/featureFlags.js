'use strict';

/**
 * aegis/featureFlags — единая точка конфигурации мозга A.E.G.I.S. (Эгида).
 *
 * Все флаги по умолчанию ВЫКЛЮЧЕНЫ: подключение A.E.G.I.S. не меняет
 * поведение существующих 9 модулей. Включение происходит постепенно
 * (Phase 1 → GraphRAG, Phase 2 → VectorDB, и т.д.).
 *
 * По требованию владельца продукта основная конфигурация хранится в
 * коде через deepFreeze (см. backend/src/services/qualityLayers/featureFlags.js).
 * URL'ы внешних сервисов и секретные ключи ЧИТАЮТСЯ из ENV (Neo4j /
 * Qdrant / Ray endpoint, GA4 OAuth, GitHub PAT) — это исключения, потому
 * что они отличаются между dev/staging/prod и не должны лежать в git.
 *
 * Чтобы поменять числовой порог — отредактируй AEGIS_FLAGS ниже.
 */

const path = require('path');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) return obj;
  for (const k of Object.keys(obj)) deepFreeze(obj[k]);
  return Object.freeze(obj);
}

function _envBool(name, dflt = false) {
  const v = process.env[name];
  if (v == null) return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function _envStr(name, dflt = '') {
  const v = process.env[name];
  return (typeof v === 'string' && v.length) ? v : dflt;
}

function _envInt(name, dflt) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : dflt;
}

function _envFloat(name, dflt) {
  const v = parseFloat(process.env[name]);
  return Number.isFinite(v) ? v : dflt;
}

/**
 * AEGIS_FLAGS — все настройки мозга A.E.G.I.S. в одном месте.
 *
 * ВАЖНО: жёсткий гейт качества Spq ≥ 8.0 (по 10-балльной шкале) /
 * ≥ 80 (по 100-балльной), как договорились с владельцем продукта.
 */
const AEGIS_FLAGS = deepFreeze({
  // ── Глобальный kill-switch ───────────────────────────────────────
  enabled: _envBool('AEGIS_ENABLED', false),

  // ── Жёсткий гейт качества (hard-fail) ────────────────────────────
  qualityGate: {
    // Минимальный overall (шкала 0..100, как computeQualityScore).
    // 80 = Spq ≥ 8.0 по 10-балльной шкале (как просил владелец продукта).
    minOverall: _envFloat('AEGIS_QUALITY_MIN_OVERALL', 80),
    // Минимальные суб-метрики (hard-fail если ниже, даже когда overall ≥ minOverall).
    minSub: {
      eeat:       _envFloat('AEGIS_QUALITY_MIN_EEAT',       70),
      fact_check: _envFloat('AEGIS_QUALITY_MIN_FACTCHECK',  70),
      plagiarism: _envFloat('AEGIS_QUALITY_MIN_PLAGIARISM', 70),
    },
    // Что делать при провале: 'fail' (бросить ошибку) или 'review'
    // (отдать клиенту с пометкой needs_human_review).
    onFail: _envStr('AEGIS_QUALITY_ON_FAIL', 'fail'),
  },

  // ── Шеннон-фильтр мусорного контента (Этап 0) ────────────────────
  shannon: {
    enabled:    _envBool('AEGIS_SHANNON_ENABLED', false),
    minEntropy: _envFloat('AEGIS_SHANNON_MIN_ENTROPY', 3.5),
    // Минимальная длина текста (символы), ниже которой считаем «слишком
    // мало для надёжного измерения» и пропускаем фильтр (не отбраковываем).
    minLength:  _envInt('AEGIS_SHANNON_MIN_LENGTH', 80),
  },

  // ── Бюджеты на одну задачу (semaphores) ──────────────────────────
  budgets: {
    geminiTaskTokens:  _envInt('AEGIS_GEMINI_TASK_TOKENS', 2_000_000),
    deepseekTaskUsd:   _envFloat('AEGIS_DEEPSEEK_TASK_USD', 5.0),
    overallTaskUsd:    _envFloat('AEGIS_OVERALL_TASK_USD', 8.0),
  },

  // ── GraphRAG (Neo4j) ─────────────────────────────────────────────
  graphrag: {
    enabled:         _envBool('AEGIS_GRAPHRAG_ENABLED', false),
    pyServiceUrl:    _envStr('AEGIS_PY_URL', 'http://localhost:8800'),
    neo4jUri:        _envStr('AEGIS_NEO4J_URI', ''),
    neo4jUser:       _envStr('AEGIS_NEO4J_USER', 'neo4j'),
    centralityTopK:  _envInt('AEGIS_GRAPHRAG_TOP_K', 12),
    cacheTtlSec:     _envInt('AEGIS_GRAPHRAG_CACHE_TTL_SEC', 3600),
    requestTimeoutMs: _envInt('AEGIS_GRAPHRAG_TIMEOUT_MS', 15000),
  },

  // ── Vector DB (Qdrant) ───────────────────────────────────────────
  vectordb: {
    enabled:      _envBool('AEGIS_VECTORDB_ENABLED', false),
    qdrantUrl:    _envStr('AEGIS_QDRANT_URL', ''),
    // Поставщик эмбеддингов: используем уже подключённый Gemini-ключ
    // (по выбору владельца продукта).
    embedder:     _envStr('AEGIS_EMBEDDER', 'gemini'), // gemini | openai | local-bge
    hybridAlpha:  _envFloat('AEGIS_VECTORDB_HYBRID_ALPHA', 0.5),
    requestTimeoutMs: _envInt('AEGIS_VECTORDB_TIMEOUT_MS', 15000),
  },

  // ── Ray Cluster ──────────────────────────────────────────────────
  ray: {
    enabled:         _envBool('AEGIS_RAY_ENABLED', false),
    headUrl:         _envStr('AEGIS_RAY_URL', ''),
    maxConcurrent:   _envInt('AEGIS_RAY_MAX_CONCURRENT', 150),
    requestTimeoutMs: _envInt('AEGIS_RAY_TIMEOUT_MS', 30000),
  },

  // ── LangGraph orchestrator ───────────────────────────────────────
  langgraph: {
    enabled:           _envBool('AEGIS_LANGGRAPH_ENABLED', false),
    maxRefineIters:    _envInt('AEGIS_LANGGRAPH_MAX_REFINE', 3),
    targetSpqOverall:  _envFloat('AEGIS_LANGGRAPH_TARGET_OVERALL', 80),
  },

  // ── DSPy эволюционный контур ─────────────────────────────────────
  dspy: {
    enabled:          _envBool('AEGIS_DSPY_ENABLED', false),
    weeklyRetrainCron: '0 2 * * 0',  // Sunday 02:00 UTC (информативно)
    maxTrials:        _envInt('AEGIS_DSPY_MAX_TRIALS', 20),
    maxCostUsd:       _envFloat('AEGIS_DSPY_MAX_COST_USD', 50),
    minImprovementPct: _envFloat('AEGIS_DSPY_MIN_IMPROVEMENT_PCT', 5),
    // Phase 14.1 — Cold-Start seed dataset. Если aegis_dspy_dataset пустой
    // (или у нас < coldStartMinRows реальных строк), используем
    // hardcoded reference TOP-1 SEO статьи из aegis_py/app/dspy_seed.py,
    // чтобы первый MIPROv2 retrain имел ground-truth.
    coldStartUseSeeds: true,
    coldStartMinRows:  _envInt('AEGIS_DSPY_COLDSTART_MIN_ROWS', 10),
    // Phase 14.2 — ε-greedy против mode collapse. В 5–10% случаев
    // генератор отступает от текущего оптимального промпта и пробует
    // мутацию (новый порядок секций / альт. шаблон заголовка / иная
    // плотность списков). Если случайно «выстрелит» в GA4, мозг
    // переучится под новый формат.
    epsilonGreedyRate:  _envFloat('AEGIS_DSPY_EPSILON', 0.07),
    epsilonGreedyMaxRate: 0.20,  // hard-cap, чтобы случайно не сорваться в 100% random
  },

  // ── RL / GA4 feedback loop ───────────────────────────────────────
  rlGa4: {
    enabled:           _envBool('AEGIS_RL_GA4_ENABLED', false),
    propertyId:        _envStr('AEGIS_GA4_PROPERTY_ID', ''),
    serviceAccountJson: _envStr('AEGIS_GA4_SA_JSON', ''),
    topCtrQuantile:    _envFloat('AEGIS_RL_TOP_QUANTILE', 0.75),
    ppoWeight:         _envFloat('AEGIS_RL_PPO_WEIGHT', 3.0),
  },

  // ── Self-mutation (DeepSeek-V4-Pro как программист) ──────────────
  selfmutate: {
    enabled:            _envBool('AEGIS_SELFMUTATE_ENABLED', false),
    // Hard-блок: первая неделя работы — только с одобрением человека.
    requireHumanReview: _envBool('AEGIS_SELFMUTATE_REQUIRE_HUMAN', true),
    // Можно править ТОЛЬКО эти подкаталоги. Остальное — read-only для бота.
    allowlistPaths: [
      'backend/src/services/parser/',
      'backend/src/services/relevance/',
      'relevance/app/',
    ],
    // Запрещённые подкаталоги (взаимная защита от рекурсивного захвата).
    blocklistPaths: [
      'backend/src/services/llm/',
      'backend/src/services/metrics/',
      'backend/src/services/aegis/',
      'backend/src/middleware/',
      'backend/src/config/',
      'migrations/',
      '.github/workflows/',
      'brain_state/',
    ],
    consecutiveFailuresTrigger: _envInt('AEGIS_SELFMUTATE_FAIL_TRIGGER', 5),
  },

  // ── GitHub бэклог (Issue-driven autopilot) ───────────────────────
  backlog: {
    enabled:    _envBool('AEGIS_BACKLOG_ENABLED', false),
    repo:       _envStr('AEGIS_GITHUB_REPO', ''), // "owner/name"
    pat:        _envStr('AEGIS_GITHUB_PAT', ''),  // PAT с правом repo
    issueLabel: _envStr('AEGIS_BACKLOG_LABEL', 'aegis:ready'),
  },

  // ── Quality Log (Discovery — Слои 1/2/3 плана) ───────────────────
  // «Теневой» датасет aegis_quality_log: пишется КАЖДАЯ генерация
  // (независимо от прохождения гейта SPQ ≥ 80) + одновременная запись
  // в aegis_runs для дашборда. failureAnalyzer мапит отчёты в симптомы.
  // Поведение writer'а НЕ меняется — это только сбор данных для RCA.
  qualityLog: {
    enabled: true,
    // Сколько записей возвращаем в GET /api/aegis/quality-log по умолчанию.
    listDefaultLimit: 30,
    listMaxLimit:     200,
    // Окно агрегации «топ причин провалов» в днях (default 7).
    topFailuresDefaultDays: 7,
    topFailuresMaxDays:     90,
    // Сколько причин выводить в карточке Discovery.
    topFailuresLimit:       15,
    // Override порогов failureAnalyzer (см. DEFAULT_THRESHOLDS).
    // Пустой объект = взять дефолты failureAnalyzer.js.
    thresholds: {},
  },

  // ── BioBrain (NEAT pre-filter) ─────────────────────────────────────
  biobrain: {
    enabled: false,
    fastRejectThreshold: 0.35,
    reviewThreshold: 0.55,
    snnEnabled: false,
    evolveIntervalSec: 300,
  },

  // ── Состояние мозга (compiled DSPy weights) ──────────────────────
  brainState: {
    rootDir:   path.join(REPO_ROOT, 'brain_state'),
    writerYaml: 'compiled_writer.yaml',
    criticYaml: 'compiled_critic.yaml',
  },

  // ── Phase 9.1 — Observability (OpenTelemetry / Prometheus) ───────
  // Метрики экспонируются на GET /api/aegis/metrics в формате
  // Prometheus exposition (text/plain). Внешний Prometheus/Grafana —
  // ОПЦИОНАЛЬНЫ: данные доступны и без них через тот же endpoint.
  telemetry: {
    enabled:     _envBool('AEGIS_TELEMETRY_ENABLED', true),
    serviceName: _envStr('AEGIS_TELEMETRY_SERVICE', 'aegis'),
    // Доп. push-режим (OTLP exporter): если установлен URL — клиент
    // периодически POST'ит снапшот метрик в JSON-формате.
    otlpHttpUrl: _envStr('AEGIS_OTLP_HTTP_URL', ''),
    pushIntervalSec: _envInt('AEGIS_TELEMETRY_PUSH_INTERVAL_SEC', 60),
  },

  // ── Phase 9.2 — Alerting & Kill Switch ───────────────────────────
  // Глобальный мониторинг расхода. Если за rollingWindowSec расход
  // превысил rateUsdPerHour — отправляется alert и (опц.) включается
  // kill switch. Telegram/Slack — опциональны (graceful если URL пуст).
  alerting: {
    enabled:           _envBool('AEGIS_ALERTING_ENABLED', false),
    // Жёсткий лимит расхода в USD/час (rolling).
    rateUsdPerHour:    _envFloat('AEGIS_ALERT_RATE_USD_PER_HOUR', 50),
    rollingWindowSec:  _envInt('AEGIS_ALERT_WINDOW_SEC', 600),
    // Автоматически включать kill switch при превышении.
    autoKillOnBreach:  _envBool('AEGIS_ALERT_AUTO_KILL', false),
    // Каналы доставки (любой пустой = пропустить).
    telegramBotToken:  _envStr('AEGIS_ALERT_TG_TOKEN', ''),
    telegramChatId:    _envStr('AEGIS_ALERT_TG_CHAT', ''),
    slackWebhookUrl:   _envStr('AEGIS_ALERT_SLACK_URL', ''),
    // Не флудить: минимальный интервал между однотипными алертами.
    cooldownSec:       _envInt('AEGIS_ALERT_COOLDOWN_SEC', 300),
  },

  // ── Phase 9.3 — Kill Switch (глобальный stop) ────────────────────
  killSwitch: {
    // initially OFF; устанавливается через POST /api/aegis/kill
    // или alerting.autoKillOnBreach. Состояние persist'ится в БД
    // (таблица aegis_killswitch, миграция 043).
    persistTable: 'aegis_killswitch',
  },

  // ── Phase 10 — Context Compression (LLMLingua-style) ─────────────
  // Детерминированное extractive сжатие промптов перед вызовом LLM.
  // Сохраняет числа, имена собственные, термины с высоким IDF;
  // удаляет стоп-слова и предложения с низким score, когда промпт
  // превышает targetTokens.
  compress: {
    enabled:        _envBool('AEGIS_COMPRESS_ENABLED', false),
    // Если promptTokens > targetTokens — сжимаем до targetTokens.
    targetTokens:   _envInt('AEGIS_COMPRESS_TARGET_TOKENS', 24000),
    // Жёсткий минимум: не сжимать промпты короче N токенов.
    minTokensToCompress: _envInt('AEGIS_COMPRESS_MIN_TOKENS', 4000),
    // Доля «важных» предложений, которая сохраняется ВСЕГДА (по топ-IDF).
    keepTopRatio:   _envFloat('AEGIS_COMPRESS_KEEP_TOP_RATIO', 0.4),
  },

  // ── Phase 11 — Backups (Qdrant snapshot + Neo4j dump → S3) ───────
  // Cron-скрипт (GitHub Actions, см. aegis-nightly-backup.yml) вызывает
  // POST /backup/run в aegis_py. S3 — опционален; без S3 снапшоты
  // лежат локально на диске (volume для дальнейшей выгрузки).
  backup: {
    enabled:        _envBool('AEGIS_BACKUP_ENABLED', false),
    s3Bucket:       _envStr('AEGIS_BACKUP_S3_BUCKET', ''),
    s3Region:       _envStr('AEGIS_BACKUP_S3_REGION', 'eu-central-1'),
    s3Prefix:       _envStr('AEGIS_BACKUP_S3_PREFIX', 'aegis/backups'),
    retainDays:     _envInt('AEGIS_BACKUP_RETAIN_DAYS', 30),
    localDir:       _envStr('AEGIS_BACKUP_LOCAL_DIR', '/var/lib/aegis/backups'),
  },

  // ── Phase 12 — LLM Routing & Circuit Breaker (Fallback) ──────────
  // При 429/502/timeout от primary провайдера маршрутизатор
  // переключается на fallback. vLLM/Llama3 — опциональны; по
  // умолчанию fallback = вторая включённая модель (deepseek↔gemini).
  routing: {
    enabled:           _envBool('AEGIS_ROUTING_ENABLED', false),
    // Comma-separated порядок попыток для critic-задач.
    criticChain:       _envStr('AEGIS_ROUTING_CRITIC_CHAIN', 'deepseek,gemini'),
    writerChain:       _envStr('AEGIS_ROUTING_WRITER_CHAIN', 'gemini,deepseek'),
    // Эндпоинт локальной vLLM/Ollama для опц. полностью офлайн-фолбэка.
    vllmUrl:           _envStr('AEGIS_VLLM_URL', ''),
    vllmModel:         _envStr('AEGIS_VLLM_MODEL', 'meta-llama/Llama-3-70B-Instruct'),
    // Circuit breaker.
    cbFailThreshold:   _envInt('AEGIS_CB_FAIL_THRESHOLD', 5),
    cbOpenSec:         _envInt('AEGIS_CB_OPEN_SEC', 60),
    cbHalfOpenProbes:  _envInt('AEGIS_CB_HALF_OPEN_PROBES', 2),
    retryOnStatus:     [408, 429, 500, 502, 503, 504],
  },

  // ── Phase 13 — Data Poisoning Filter (anti-injection) ────────────
  // Доп. фильтр перед записью в векторную базу. Защита от:
  //   - скрытого текста (display:none / visibility:hidden / font-size:0
  //     / цвет = фону)
  //   - keyword stuffing (n-gram повтор > порога)
  //   - управляющих/невидимых юникод-символов (ZWSP, RTL-override…)
  //   - числовых выбросов (значения вне 5x от медианы по нише)
  poison: {
    enabled:                 _envBool('AEGIS_POISON_ENABLED', true),
    hiddenTextMaxRatio:      _envFloat('AEGIS_POISON_HIDDEN_MAX_RATIO', 0.05),
    keywordStuffMaxRepeat:   _envInt('AEGIS_POISON_NGRAM_MAX_REPEAT', 8),
    invisibleCharMaxRatio:   _envFloat('AEGIS_POISON_INVISIBLE_MAX_RATIO', 0.01),
    numericOutlierMultiplier: _envFloat('AEGIS_POISON_NUMERIC_OUTLIER_X', 5.0),
    // Что делать с провалившим фильтр блоком: drop (выкинуть),
    // mark (записать с meta.poisoned=true для последующего исключения).
    onFail:                  _envStr('AEGIS_POISON_ON_FAIL', 'drop'),
  },

  // ── Phase 14 — Vector DB Tombstones / GC ─────────────────────────
  // Qdrant раздувается, если /evidence-абзацы скрапятся 24/7. GC
  // удаляет точки с payload.created_at старше ttlDays и/или точки
  // конкретного aegis-прогона после aegis_runs.status='success'.
  // Ночной cron — .github/workflows/aegis-nightly-vector-gc.yml.
  vectorGc: {
    enabled:           _envBool('AEGIS_VECTOR_GC_ENABLED', true),
    // TTL для эфемерных коллекций (evidence/serp/relevance).
    ttlDays:           _envInt('AEGIS_VECTOR_GC_TTL_DAYS', 30),
    // После успешного aegis_runs.status='success' зачищать точки
    // с payload.run_id = <run_id> (мгновенный per-run cleanup).
    perRunCleanup:     _envBool('AEGIS_VECTOR_GC_PER_RUN', true),
    // Префиксы коллекций, к которым применяется sweep по TTL
    // (постоянные «brain»-коллекции, например aegis_okna, не трогаем).
    ephemeralCollectionPrefixes: ['evidence_', 'serp_', 'relevance_'],
    // Жёсткий минимум: не сносить точки моложе этого числа часов,
    // даже если кто-то поставит ttlDays=0 по ошибке.
    minAgeSafetyHours: 24,
    // Информативно: расписание (фактический cron в workflow).
    nightlyCron:       '15 3 * * *',
  },

  // ── Phase 14 — Aegis hooks в модуле релевантности ────────────────
  // Точечная интеграция мозга в /api/relevance: telemetry-спаны,
  // poison-фильтр для скачанных страниц (анти-отравленные данные
  // от конкурентов), компрессия больших SERP-evidence перед DeepSeek.
  // Все шаги — graceful: если AEGIS_ENABLED=false или конкретный
  // под-флаг выключен, поведение не меняется.
  relevanceAegis: {
    enabled:               _envBool('AEGIS_RELEVANCE_ENABLED', true),
    telemetrySpans:        _envBool('AEGIS_RELEVANCE_TELEMETRY', true),
    poisonFilterFetched:   _envBool('AEGIS_RELEVANCE_POISON_FILTER', true),
    // Если итоговый промпт для deepseekAnalyzer (контекст SERP+ours)
    // превышает targetTokens (см. compress.targetTokens), применяем
    // promptCompressor. По умолчанию OFF, чтобы не менять текущие
    // выходы аналитика — включается осознанно.
    compressDeepseekPrompt: _envBool('AEGIS_RELEVANCE_COMPRESS_PROMPT', false),
    // После завершения отчёта (status='done') зачищать векторные
    // точки текущего relevance-прогона (если vectorGc.enabled).
    vectorGcOnDone:        _envBool('AEGIS_RELEVANCE_VECTOR_GC', true),
  },
});

// ── Валидация диапазонов (fail-fast при старте) ───────────────────
const RANGES = [
  ['qualityGate.minOverall',          0, 100],
  ['qualityGate.minSub.eeat',         0, 100],
  ['qualityGate.minSub.fact_check',   0, 100],
  ['qualityGate.minSub.plagiarism',   0, 100],
  ['shannon.minEntropy',              0, 8],
  ['shannon.minLength',               1, 100000],
  ['budgets.geminiTaskTokens',        1000, 100_000_000],
  ['budgets.deepseekTaskUsd',         0, 10000],
  ['budgets.overallTaskUsd',          0, 10000],
  ['graphrag.centralityTopK',         1, 1000],
  ['graphrag.cacheTtlSec',            1, 86400 * 30],
  ['vectordb.hybridAlpha',            0, 1],
  ['ray.maxConcurrent',               1, 10000],
  ['langgraph.maxRefineIters',        0, 20],
  ['langgraph.targetSpqOverall',      0, 100],
  ['dspy.maxTrials',                  1, 1000],
  ['dspy.maxCostUsd',                 0, 100000],
  ['dspy.minImprovementPct',          0, 1000],
  ['rlGa4.topCtrQuantile',            0, 1],
  ['rlGa4.ppoWeight',                 1, 100],
  ['selfmutate.consecutiveFailuresTrigger', 1, 1000],
  // Phase 9–13 ranges
  ['telemetry.pushIntervalSec',       1, 86400],
  ['alerting.rateUsdPerHour',         0, 100000],
  ['alerting.rollingWindowSec',       60, 86400],
  ['alerting.cooldownSec',            1, 86400],
  ['compress.targetTokens',           100, 1_000_000],
  ['compress.minTokensToCompress',    0, 1_000_000],
  ['compress.keepTopRatio',           0, 1],
  ['backup.retainDays',               1, 3650],
  ['routing.cbFailThreshold',         1, 1000],
  ['routing.cbOpenSec',               1, 86400],
  ['routing.cbHalfOpenProbes',        1, 100],
  ['poison.hiddenTextMaxRatio',       0, 1],
  ['poison.keywordStuffMaxRepeat',    1, 10000],
  ['poison.invisibleCharMaxRatio',    0, 1],
  ['poison.numericOutlierMultiplier', 1, 1000],
  // Phase 14 ranges
  ['dspy.coldStartMinRows',           0, 1000],
  ['dspy.epsilonGreedyRate',          0, 1],
  ['dspy.epsilonGreedyMaxRate',       0, 1],
  ['biobrain.fastRejectThreshold',    0, 1],
  ['biobrain.reviewThreshold',        0, 1],
  ['biobrain.evolveIntervalSec',      1, 86400],
  ['vectorGc.ttlDays',                0, 3650],
  ['vectorGc.minAgeSafetyHours',      0, 24 * 365],
];

function _get(obj, p) {
  return p.split('.').reduce((a, k) => (a == null ? a : a[k]), obj);
}

(function _validate() {
  for (const [p, min, max] of RANGES) {
    const v = _get(AEGIS_FLAGS, p);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`[aegis/featureFlags] ${p}=${v} вне допустимого диапазона [${min}..${max}]`);
    }
  }
  if (!['fail', 'review'].includes(AEGIS_FLAGS.qualityGate.onFail)) {
    throw new Error(`[aegis/featureFlags] qualityGate.onFail должен быть 'fail' или 'review'`);
  }
  if (!['drop', 'mark'].includes(AEGIS_FLAGS.poison.onFail)) {
    throw new Error(`[aegis/featureFlags] poison.onFail должен быть 'drop' или 'mark'`);
  }
  if (AEGIS_FLAGS.biobrain.reviewThreshold < AEGIS_FLAGS.biobrain.fastRejectThreshold) {
    throw new Error('[aegis/featureFlags] biobrain.reviewThreshold должен быть >= fastRejectThreshold');
  }
})();

function getAegisFlags() {
  return AEGIS_FLAGS;
}

module.exports = { getAegisFlags, AEGIS_FLAGS };
