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

  // ── Состояние мозга (compiled DSPy weights) ──────────────────────
  brainState: {
    rootDir:   path.join(REPO_ROOT, 'brain_state'),
    writerYaml: 'compiled_writer.yaml',
    criticYaml: 'compiled_critic.yaml',
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
})();

function getAegisFlags() {
  return AEGIS_FLAGS;
}

module.exports = { getAegisFlags, AEGIS_FLAGS };
