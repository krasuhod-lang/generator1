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
    filePath: '/var/log/seo-genius/validation-failures.jsonl',
  },

  // ── C2. Унифицированный E-E-A-T таргет ───────────────────────────
  eeatTargetDefault: 7.5,          // 0..10
});

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
