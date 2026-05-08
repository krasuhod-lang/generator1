'use strict';

/**
 * featureFlags — единая точка чтения ENV-флагов для новых quality-слоёв
 * info-article (план «Усиление пайплайна "Комбайн"»).
 *
 * По нефункциональному требованию плана: все новые слои за фича-флагами,
 * default — выключено до пилота. Здесь же — числовые пороги, чтобы
 * pipeline и UI не парсили env по разным местам.
 *
 * Наименования в env синхронизированы с .env.example (см. секцию
 * "Quality layers — info-article «Комбайн» upgrade").
 */

function envBool(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const v = String(raw).toLowerCase().trim();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return defaultValue;
}

function envFloat(name, defaultValue, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return defaultValue;
  if (v < min || v > max) return defaultValue;
  return v;
}

function envInt(name, defaultValue, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const v = parseInt(raw, 10);
  if (!Number.isFinite(v)) return defaultValue;
  if (v < min || v > max) return defaultValue;
  return v;
}

/**
 * getQualityFlags — возвращает snapshot текущих значений ENV.
 *
 * Snapshot создаётся при каждом вызове (без кэша), чтобы тесты могли
 * перевыставлять process.env между сценариями.
 */
function getQualityFlags() {
  return {
    // ── A1. Fact-checking слой ─────────────────────────────────────
    factcheck: {
      enabled: envBool('INFO_ARTICLE_FACTCHECK_ENABLED', false),
      minSupportedRatio: envFloat(
        'INFO_ARTICLE_FACTCHECK_MIN_SUPPORTED_RATIO',
        0.7,
        { min: 0, max: 1 },
      ),
      blockOnContradicted: envBool(
        'INFO_ARTICLE_FACTCHECK_BLOCK_ON_CONTRADICTED',
        true,
      ),
    },

    // ── A2. Writer grounding ───────────────────────────────────────
    grounding: {
      enabled: envBool('INFO_ARTICLE_WRITER_GROUNDING_ENABLED', false),
      tokensPerH2: envInt(
        'INFO_ARTICLE_GROUNDING_TOKENS_PER_H2',
        500,
        { min: 50, max: 4000 },
      ),
      totalBudget: envInt(
        'INFO_ARTICLE_GROUNDING_TOTAL_BUDGET',
        3500,
        { min: 200, max: 32000 },
      ),
      passagesPerH2: envInt(
        'INFO_ARTICLE_GROUNDING_PASSAGES_PER_H2',
        5,
        { min: 1, max: 20 },
      ),
    },

    // ── A3. Антиплагиат ────────────────────────────────────────────
    plagiarism: {
      externalEnabled: envBool('INFO_ARTICLE_PLAGIARISM_ENABLED', false),
      maxOverlap: envFloat(
        'INFO_ARTICLE_PLAGIARISM_MAX_OVERLAP',
        0.18,
        { min: 0, max: 1 },
      ),
      shingleSize: envInt(
        'INFO_ARTICLE_PLAGIARISM_SHINGLE_N',
        6,
        { min: 3, max: 12 },
      ),
      selfplagEnabled: envBool('INFO_ARTICLE_SELFPLAG_ENABLED', false),
      selfplagMaxCosine: envFloat(
        'INFO_ARTICLE_SELFPLAG_MAX_COSINE',
        0.92,
        { min: 0, max: 1 },
      ),
      selfplagMinChars: envInt(
        'INFO_ARTICLE_SELFPLAG_MIN_CHARS',
        120,
        { min: 30, max: 1000 },
      ),
    },

    // ── A4. QA картинок ────────────────────────────────────────────
    imageQa: {
      enabled: envBool('INFO_ARTICLE_IMAGE_QA_ENABLED', false),
      maxRetries: envInt('IMAGE_QA_MAX_RETRIES', 2, { min: 0, max: 5 }),
      altVisualMinCosine: envFloat(
        'IMAGE_ALT_VISUAL_MIN_COSINE',
        0.22,
        { min: 0, max: 1 },
      ),
    },

    // ── B1. Чанковый E-E-A-T audit ─────────────────────────────────
    eeatChunked: {
      enabled: envBool('INFO_ARTICLE_EEAT_CHUNKED', false),
      chunkTargetChars: envInt(
        'INFO_ARTICLE_EEAT_CHUNK_TARGET_CHARS',
        8000,
        { min: 1500, max: 30000 },
      ),
    },

    // ── B2. Семантическая LSI-метрика ──────────────────────────────
    lsiSemantic: {
      enabled: envBool('INFO_ARTICLE_LSI_SEMANTIC_ENABLED', false),
      threshold: envFloat(
        'LSI_SEMANTIC_COVERAGE_THRESHOLD',
        0.55,
        { min: 0, max: 1 },
      ),
    },

    // ── B3. Косинус в semantic link planner ────────────────────────
    linkSemantic: {
      cosineWeight: envFloat(
        'LINK_SEMANTIC_COSINE_WEIGHT',
        0.5,
        { min: 0, max: 1 },
      ),
      minCosine: envFloat(
        'LINK_MIN_SEMANTIC_COSINE',
        0.35,
        { min: 0, max: 1 },
      ),
    },

    // ── B4. Читабельность ──────────────────────────────────────────
    readability: {
      enabled: envBool('INFO_ARTICLE_READABILITY_ENABLED', false),
      minIndex: envFloat(
        'READABILITY_MIN_INDEX',
        55,
        { min: 0, max: 100 },
      ),
      maxAvgSentenceLen: envFloat(
        'READABILITY_MAX_AVG_SENTENCE_LEN',
        22,
        { min: 5, max: 60 },
      ),
      maxPassiveRatio: envFloat(
        'READABILITY_MAX_PASSIVE_RATIO',
        0.18,
        { min: 0, max: 1 },
      ),
      maxBureaucrateseRatio: envFloat(
        'READABILITY_MAX_BUREAUCRATESE_RATIO',
        0.04,
        { min: 0, max: 1 },
      ),
    },

    // ── B5. Verifying intent ───────────────────────────────────────
    intentVerify: {
      enabled: envBool('INFO_ARTICLE_INTENT_VERIFY_ENABLED', false),
      blockOnMismatch: envBool(
        'INFO_ARTICLE_INTENT_BLOCK_ON_MISMATCH',
        false,
      ),
    },

    // ── C1. Prompt regression tracking ─────────────────────────────
    validationLog: {
      enabled: envBool('INFO_ARTICLE_VALIDATION_LOG_ENABLED', false),
      filePath:
        process.env.INFO_ARTICLE_VALIDATION_LOG_PATH ||
        '/var/log/seo-genius/validation-failures.jsonl',
    },

    // ── C2. Унифицированный E-E-A-T таргет ─────────────────────────
    eeatTargetDefault: envFloat(
      'EEAT_TARGET_DEFAULT',
      7.5,
      { min: 0, max: 10 },
    ),
  };
}

module.exports = { getQualityFlags, envBool, envFloat, envInt };
