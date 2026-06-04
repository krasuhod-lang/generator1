'use strict';

/**
 * featureFlags — единая точка конфигурации новых quality-слоёв
 * info-article (план «Усиление пайплайна "Комбайн"»).
 *
 * ВНИМАНИЕ: значения зашиты прямо в код намеренно — по требованию
 * владельца продукта вся конфигурация для слоёв качества хранится
 * программно, без чтения переменных окружения.
 *
 * Чтобы изменить порог или включить/выключить слой — отредактируй
 * соответствующее поле в QUALITY_FLAGS ниже и перезапусти backend.
 *
 * Дефолты соответствуют плану «Комбайн» (см. README/план в репозитории).
 * Все слои по умолчанию ВЫКЛЮЧЕНЫ — поведение pipeline без явного
 * включения не меняется.
 */

/**
 * deepFreeze — рекурсивно замораживает объект, чтобы исключить
 * случайные мутации конфигурации в рантайме.
 */
function deepFreeze(obj) {
  if (obj === null || typeof obj !== 'object' || Object.isFrozen(obj)) {
    return obj;
  }
  for (const key of Object.keys(obj)) {
    deepFreeze(obj[key]);
  }
  return Object.freeze(obj);
}

/**
 * QUALITY_FLAGS — единственный источник истины для конфигурации
 * слоёв качества. Заморожен для защиты от случайных мутаций.
 */
const QUALITY_FLAGS = deepFreeze({
  // ── A1. Fact-checking слой ───────────────────────────────────────
  factcheck: {
    enabled: false,
    minSupportedRatio: 0.7,        // 0..1
    blockOnContradicted: true,
  },

  // ── A2. Writer grounding ─────────────────────────────────────────
  grounding: {
    enabled: false,
    tokensPerH2: 500,              // 50..4000
    totalBudget: 3500,             // 200..32000
    passagesPerH2: 5,              // 1..20
  },

  // ── A3. Антиплагиат ──────────────────────────────────────────────
  plagiarism: {
    externalEnabled: false,
    maxOverlap: 0.18,              // 0..1
    shingleSize: 6,                // 3..12
    selfplagEnabled: false,
    selfplagMaxCosine: 0.92,       // 0..1
    selfplagMinChars: 120,         // 30..1000
  },

  // ── A4. QA картинок ──────────────────────────────────────────────
  imageQa: {
    enabled: false,
    maxRetries: 2,                 // 0..5
    altVisualMinCosine: 0.22,      // 0..1
  },

  // ── B1. Чанковый E-E-A-T audit ───────────────────────────────────
  eeatChunked: {
    enabled: false,
    chunkTargetChars: 8000,        // 1500..30000
  },

  // ── B2. Семантическая LSI-метрика ────────────────────────────────
  lsiSemantic: {
    enabled: false,
    threshold: 0.55,               // 0..1
  },

  // ── B3. Косинус в semantic link planner ──────────────────────────
  linkSemantic: {
    cosineWeight: 0.5,             // 0..1
    minCosine: 0.35,               // 0..1
  },

  // ── B4. Читабельность ────────────────────────────────────────────
  readability: {
    enabled: false,
    minIndex: 55,                  // 0..100, выше — проще
    maxAvgSentenceLen: 22,         // 5..60 слов
    maxPassiveRatio: 0.18,         // 0..1
    maxBureaucrateseRatio: 0.04,   // 0..1
  },

  // ── B5. Verifying intent ─────────────────────────────────────────
  intentVerify: {
    enabled: false,
    blockOnMismatch: false,
  },

  // ── C1. Prompt regression tracking ───────────────────────────────
  validationLog: {
    enabled: false,
    // Безопасный дефолт под os.tmpdir() — на dev/CI работает без прав на /var/log.
    // На проде задайте абсолютный путь (например `/var/log/seo-genius/...`).
    filePath: require('path').join(require('os').tmpdir(), 'seo-genius', 'validation-failures.jsonl'),
  },

  // ── C3. Структурные ACF-валидаторы ───────────────────────────────
  acfStructural: {
    // canon-substrings, при попадании которых дубликат НЕ считается ошибкой
    // (бренд, телефон, постоянная цитата CTA и т.п.). Строки нормализуются
    // в canon-форму внутри validator-а (lower-case + только буквы/цифры).
    // По умолчанию пусто — никаких исключений.
    duplicatesAllowlist: [],
    duplicatesMinLen: 80,           // 30..1000
  },

  // ── C2. Унифицированный E-E-A-T таргет ───────────────────────────
  eeatTargetDefault: 7.5,          // 0..10

  // ── D2. Голос аудитории (Reddit Mapper V2 → IAKB §10) ────────────
  // Прогон redditMapperPipeline (7 этапов) для исследования реальных
  // болей/языка/вопросов аудитории и подача дайджеста в knowledge base
  // §10 как Information-Gain топливо. По умолчанию ВЫКЛ — поведение
  // pipeline без явного включения не меняется (graceful: при has_signal=
  // false или любой ошибке статья генерируется как раньше).
  // См. backend/src/services/infoArticle/audienceResearch.service.js
  audienceResearch: {
    enabled: false,
    provider: 'deepseek',          // LLM-провайдер для всех этапов
    // A/B: доля задач (из попавших под enabled) в тест-группе с §10.
    // Контрольная группа генерируется БЕЗ §10 — для сравнения качества
    // (Information Gain / уникальность / покрытие болей). Бакет
    // детерминирован по taskId. 1.0 = все в тест-группе; 0.5 = 50/50.
    abSampleRatio: 1.0,            // 0..1
    // Кэш дайджеста по ключу niche|geo (одна тема/регион → один прогон).
    cacheTtlMinutes: 1440,         // 5..43200
    cacheMaxEntries: 200,          // 10..5000
  },

  // ── D1. Brand-aware дедуп тем (article_topics_brand_history) ─────
  // detector: exact → Jaccard → опционально DeepSeek. Новые темы
  // никогда не отбрасываются, только помечаются duplicate_of. См.
  // backend/src/services/articleTopics/topicDuplicateDetector.js
  brandDedup: {
    enabled: true,
    useLlm: true,
    historyLookbackDays: 365,
    historyLimit: 500,
    maxLlmCandidates: 20,
    // 2026-05 (Sprint A): пометить дубликат → выкинуть его из выдачи.
    // По умолчанию OFF для BC: pipeline просто помечает duplicate_of.
    dropDuplicates: false,
    // Авто-консолидация bram_key через char-bigram cosine ≥ threshold:
    // если новый brand_hint похож на существующий → регистрируем alias.
    autoAlias: true,
    autoAliasThreshold: 0.85,
  },
});

/**
 * RANGES — задекларированные в комментариях диапазоны значений.
 * Проверяются один раз при загрузке модуля; при нарушении бросаем
 * Error — это страховка от опечаток вроде `maxPassiveRatio: 1.8`.
 * Не покрывает enabled-флаги (boolean) и filePath (string).
 */
const RANGES = [
  ['factcheck.minSupportedRatio',         0, 1],
  ['grounding.tokensPerH2',               50, 4000],
  ['grounding.totalBudget',               200, 32000],
  ['grounding.passagesPerH2',             1, 20],
  ['plagiarism.maxOverlap',               0, 1],
  ['plagiarism.shingleSize',              3, 12],
  ['plagiarism.selfplagMaxCosine',        0, 1],
  ['plagiarism.selfplagMinChars',         30, 1000],
  ['imageQa.maxRetries',                  0, 5],
  ['imageQa.altVisualMinCosine',          0, 1],
  ['eeatChunked.chunkTargetChars',        1500, 30000],
  ['lsiSemantic.threshold',               0, 1],
  ['linkSemantic.cosineWeight',           0, 1],
  ['linkSemantic.minCosine',              0, 1],
  ['readability.minIndex',                0, 100],
  ['readability.maxAvgSentenceLen',       5, 60],
  ['readability.maxPassiveRatio',         0, 1],
  ['readability.maxBureaucrateseRatio',   0, 1],
  ['acfStructural.duplicatesMinLen',      30, 1000],
  ['eeatTargetDefault',                   0, 10],
  ['audienceResearch.abSampleRatio',      0, 1],
  ['audienceResearch.cacheTtlMinutes',    5, 43200],
  ['audienceResearch.cacheMaxEntries',    10, 5000],
  ['brandDedup.historyLookbackDays',      1, 3650],
  ['brandDedup.historyLimit',             10, 5000],
  ['brandDedup.maxLlmCandidates',         0, 200],
  ['brandDedup.autoAliasThreshold',       0, 1],
];

function _get(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function _validateRanges(cfg) {
  for (const [pathStr, min, max] of RANGES) {
    const v = _get(cfg, pathStr);
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(
        `[qualityLayers/featureFlags] ${pathStr}=${v} вне допустимого диапазона [${min}..${max}]`,
      );
    }
  }
  // Дополнительно: duplicatesAllowlist должен быть массивом строк.
  const allow = _get(cfg, 'acfStructural.duplicatesAllowlist');
  if (!Array.isArray(allow) || allow.some((s) => typeof s !== 'string')) {
    throw new Error('[qualityLayers/featureFlags] acfStructural.duplicatesAllowlist должен быть массивом строк');
  }
  // validationLog.filePath — непустая строка.
  const fp = _get(cfg, 'validationLog.filePath');
  if (typeof fp !== 'string' || !fp.length) {
    throw new Error('[qualityLayers/featureFlags] validationLog.filePath должен быть непустой строкой');
  }
}

// Fail-fast при старте процесса, если конфигурация невалидна.
_validateRanges(QUALITY_FLAGS);

/**
 * getQualityFlags — возвращает frozen-snapshot конфигурации.
 *
 * Возвращает один и тот же объект между вызовами (значения зашиты в
 * код). Объект и все вложенные структуры заморожены — попытка мутации
 * в strict-mode бросит TypeError.
 */
function getQualityFlags() {
  return QUALITY_FLAGS;
}

module.exports = { getQualityFlags };
